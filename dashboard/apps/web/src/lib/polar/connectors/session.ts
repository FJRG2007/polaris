/**
 * Talking to a connector: the MCP SDK's client over Streamable HTTP (or the
 * older HTTP+SSE transport for a server that only has that), opened for one
 * check or one call and closed after it.
 *
 * Every byte goes through `connectorFetch`, so the SDK never opens a socket
 * of its own: the private-range check, the timeout and the byte ceiling hold
 * for the MCP traffic and for every OAuth request alike. The token is sent
 * in the `Authorization` header and nowhere else, as the spec requires (a
 * server that asks for its own headers instead gets the stored ones), and
 * an OAuth token close to its end - or one the server turns away - is refreshed
 * first and stored again.
 *
 * Server-only. Anything a person sees from here is a code
 * (`ConnectorFailure`), never the server's own words: an error message from
 * somebody else's server is somebody else's text.
 */

import { appBaseUrl } from "@/lib/domain-service";
import * as oauth from "@/lib/polar/connectors/oauth";
import * as store from "@/lib/polar/connectors/store";
import { hostAllowed } from "@/lib/polar/connectors/shared";
import { connectorFetch } from "@/lib/polar/connectors/fetch";
import { paramHeadersFor, withParamHeaders } from "@/lib/polar/connectors/param-headers";
import type { PolarConnectorPolicy } from "@/lib/polar/access";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
    toCachedTools,
    connectorRequestHeaders,
    CONNECTOR_TOOL_LIMIT
} from "@/lib/polar/connectors/policy";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** How long one tool call may take, end to end. */
const CALL_TIMEOUT_MS = 60_000;
/** Pages of `tools/list` read before the list is taken as it is. */
const LIST_PAGES = 5;

export type ConnectorFailure = "sign_in" | "unreachable" | "refused" | "host" | "failed";

export class ConnectorError extends Error {
    constructor(readonly code: ConnectorFailure) {
        super(code);
        this.name = "ConnectorError";
    }
}

export async function callbackUrl(): Promise<string> {
    return `${(await appBaseUrl()).replace(/\/+$/, "")}/api/polar/connectors/callback`;
}

function fetchFor(policy: PolarConnectorPolicy, transport: "http" | "sse" | "auth") {
    return connectorFetch({
        allowPrivate: policy.privateNetwork,
        timeoutMs: transport === "auth" ? 15_000 : CALL_TIMEOUT_MS,
        listen: transport === "sse"
    });
}

/** Why a request failed, as one of the codes the screen has words for. */
function failureOf(error: unknown): ConnectorFailure {
    if (error instanceof ConnectorError) return error.code;
    const record = error as { code?: unknown; name?: unknown; message?: unknown };
    if (record?.code === 401 || record?.name === "UnauthorizedError") return "sign_in";
    const message = typeof record?.message === "string" ? record.message : "";
    if (/\b401\b|unauthori[sz]ed/i.test(message)) return "sign_in";
    if (record?.name === "RefusedAddressError") return "refused";
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|timed? ?out|aborted/i.test(message))
        return "unreachable";
    return "failed";
}

/** The bearer token to send, refreshing an OAuth one that is about to end. */
async function bearerFor(
    found: { row: store.ConnectorRow; secret: store.ConnectorSecret | null },
    policy: PolarConnectorPolicy
): Promise<string | null> {
    const { row, secret } = found;
    if (row.auth === "none") return null;
    if (row.auth === "headers") {
        if (!Object.keys(secret?.headers ?? {}).length) throw new ConnectorError("sign_in");
        return null;
    }
    if (row.auth === "bearer") {
        if (!secret?.token) throw new ConnectorError("sign_in");
        return secret.token;
    }
    if (!secret?.tokens || !secret.client) throw new ConnectorError("sign_in");
    if (!oauth.tokenExpiring(secret.tokens)) return secret.tokens.accessToken;
    return refreshOnce(row, policy);
}

/** Refreshes in flight, by connector: one refresh token is spent once. */
const refreshing = new Map<string, Promise<string>>();

/**
 * `rejected` is an access token the server just answered 401 to: it is
 * refreshed whatever its stored expiry says - a server that gave none, a
 * token revoked early, a clock that disagrees - unless another call has
 * already replaced it.
 */
function refreshOnce(
    row: store.ConnectorRow,
    policy: PolarConnectorPolicy,
    rejected: string | null = null
): Promise<string> {
    const running = refreshing.get(row.id);
    if (running) return running;
    const started = refresh(row, policy, rejected).finally(() => refreshing.delete(row.id));
    refreshing.set(row.id, started);
    return started;
}

async function refresh(
    row: store.ConnectorRow,
    policy: PolarConnectorPolicy,
    rejected: string | null
): Promise<string> {
    // Read again: another call may have refreshed since this one read it.
    const secret = (await store.ownConnector(row.ownerId, row.id))?.secret;
    if (!secret?.tokens || !secret.client) throw new ConnectorError("sign_in");
    const stale = rejected !== null && secret.tokens.accessToken === rejected;
    if (!stale && !oauth.tokenExpiring(secret.tokens)) return secret.tokens.accessToken;
    const spent = secret.tokens.refreshToken;
    if (!spent) throw new ConnectorError("sign_in");
    let tokens: oauth.ConnectorTokens;
    try {
        tokens = await oauth.refreshTokens(fetchFor(policy, "auth"), secret.client, spent);
    } catch {
        throw new ConnectorError("sign_in");
    }
    // Stored on top of what is there now; a sign-in that finished meanwhile wins.
    const stored = await store.updateSecret(row.ownerId, row.id, (current) =>
        current?.tokens?.refreshToken === spent
            ? { secret: { ...current, tokens }, result: tokens.accessToken }
            : { secret: current, result: current?.tokens?.accessToken ?? null }
    );
    if (!stored) throw new ConnectorError("sign_in");
    return stored;
}

/** The `tools/call` a client is opened for, and the `Mcp-Param-*` headers it carries. */
interface ToolCallHeaders {
    tool: string;
    headers: Record<string, string>;
}

/** Opens the connector, runs `run`, and always closes it again. */
async function withClient<T>(
    found: { row: store.ConnectorRow; secret: store.ConnectorSecret | null },
    policy: PolarConnectorPolicy,
    run: (client: Client) => Promise<T>,
    call?: ToolCallHeaders
): Promise<T> {
    // Checked again on every use: an administrator may have narrowed the
    // hosts since this connector was added.
    if (!hostAllowed(found.row.url, policy.hosts)) throw new ConnectorError("host");
    const token = await bearerFor(found, policy);
    try {
        return await openAndRun(found, policy, token, run, call);
    } catch (error) {
        // An OAuth token the server turned away is refreshed once and the
        // request made again, before the person is asked to sign in.
        const refreshable =
            error instanceof ConnectorError &&
            error.code === "sign_in" &&
            found.row.auth === "oauth" &&
            token !== null &&
            Boolean(found.secret?.tokens?.refreshToken);
        if (!refreshable) throw error;
        const fresh = await refreshOnce(found.row, policy, token);
        return openAndRun(found, policy, fresh, run, call);
    }
}

async function openAndRun<T>(
    found: { row: store.ConnectorRow; secret: store.ConnectorSecret | null },
    policy: PolarConnectorPolicy,
    token: string | null,
    run: (client: Client) => Promise<T>,
    call?: ToolCallHeaders
): Promise<T> {
    const url = new URL(found.row.url);
    const headers = connectorRequestHeaders(found.row.auth, {
        bearer: token,
        headers: found.secret?.headers ?? null
    });
    const requestInit: RequestInit = Object.keys(headers).length ? { headers } : {};
    const transport =
        found.row.transport === "sse"
            ? new SSEClientTransport(url, {
                  fetch: fetchFor(policy, "sse"),
                  requestInit,
                  eventSourceInit: { fetch: fetchFor(policy, "sse") } as never
              })
            : new StreamableHTTPClientTransport(url, {
                  fetch: call
                      ? withParamHeaders(fetchFor(policy, "http"), call.tool, call.headers)
                      : fetchFor(policy, "http"),
                  requestInit
              });
    const client = new Client({ name: "Polaris", version: "1.0.0" }, { capabilities: {} });
    try {
        await client.connect(transport, { timeout: 20_000 });
        return await run(client);
    } catch (error) {
        throw new ConnectorError(failureOf(error));
    } finally {
        await client.close().catch(() => undefined);
    }
}

/**
 * Test connection: reads the tool list, stores it, and answers the connector
 * as the screen shows it. A failure is stored as its code.
 */
export async function checkConnector(
    ownerId: string,
    id: string
): Promise<store.ConnectorView | null> {
    const found = await store.ownConnector(ownerId, id);
    if (!found) return null;
    const policy = await store.connectorPolicy();
    try {
        const listed = await withClient(found, policy, async (client) => {
            const tools: unknown[] = [];
            let cursor: string | undefined;
            for (
                let page = 0;
                page < LIST_PAGES && tools.length < CONNECTOR_TOOL_LIMIT;
                page += 1
            ) {
                const answer = await client.listTools(cursor ? { cursor } : undefined, {
                    timeout: 20_000
                });
                tools.push(...answer.tools);
                cursor = answer.nextCursor;
                if (!cursor) break;
            }
            return tools;
        });
        await store.recordCheck(ownerId, id, {
            status: "ok",
            tools: toCachedTools(listed, found.row.transport)
        });
    } catch (error) {
        const code = failureOf(error);
        await store.recordCheck(ownerId, id, {
            status: code === "sign_in" ? "sign_in" : "error",
            error: code
        });
    }
    const after = await store.ownConnector(ownerId, id);
    return after ? store.viewOf(after.row, after.secret) : null;
}

/** One tool call, answered as the server's raw result for `policy.ts` to read. */
export async function callConnectorTool(
    ownerId: string,
    id: string,
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal
): Promise<unknown> {
    const found = await store.ownConnector(ownerId, id);
    if (!found || !found.row.enabled) throw new ConnectorError("failed");
    const policy = await store.connectorPolicy();
    // Built from the tool list stored at the last check, the most recent
    // `inputSchema` Polaris has; a tool never listed sends none. Only Streamable
    // HTTP carries them, as the spec scopes them.
    const listed = found.row.tools.find((entry) => entry.name === tool);
    const headers =
        found.row.transport === "http" && listed ? paramHeadersFor(listed.inputSchema, input) : {};
    return withClient(
        found,
        policy,
        (client) =>
            client.callTool({ name: tool, arguments: input }, undefined, {
                timeout: CALL_TIMEOUT_MS,
                ...(signal ? { signal } : {})
            }),
        { tool, headers }
    );
}

export type SignInRefusal =
    "not_found" | "not_oauth" | "host" | oauth.ConnectorAuthError["code"] | "failed";

/** Where to send the person to sign the connector in. */
export async function startSignIn(
    ownerId: string,
    id: string
): Promise<{ url: string } | SignInRefusal> {
    const found = await store.ownConnector(ownerId, id);
    if (!found) return "not_found";
    if (found.row.auth !== "oauth") return "not_oauth";
    const policy = await store.connectorPolicy();
    if (!hostAllowed(found.row.url, policy.hosts)) return "host";
    try {
        const begun = await oauth.beginAuthorization(fetchFor(policy, "auth"), {
            connectorId: id,
            server: found.row.url,
            redirectUri: await callbackUrl(),
            registered: found.secret?.registered ?? null
        });
        await store.updateSecret(ownerId, id, (current) => ({
            secret: { ...(current ?? {}), pending: begun.pending },
            result: true
        }));
        return { url: begun.authorizationUrl };
    } catch (error) {
        if (error instanceof oauth.ConnectorAuthError) return error.code;
        console.error("polar: connector sign-in could not start", error);
        return "failed";
    }
}

/** The callback: spends the code, stores the tokens, and checks the connector. */
export async function finishSignIn(
    ownerId: string,
    state: string,
    code: string
): Promise<string | null> {
    const id = oauth.stateConnectorId(state);
    if (!id) return null;
    const found = await store.ownConnector(ownerId, id);
    const pending = found?.secret?.pending;
    if (!found || !pending) return null;
    const policy = await store.connectorPolicy();
    const spend = (current: store.ConnectorSecret | null) => {
        const { pending: _spent, ...rest } = current ?? {};
        return rest;
    };
    try {
        const tokens = await oauth.finishAuthorization(fetchFor(policy, "auth"), pending, {
            state,
            code
        });
        const client = {
            clientId: pending.clientId,
            clientSecret: pending.clientSecret,
            tokenEndpoint: pending.tokenEndpoint,
            authMethod: pending.authMethod,
            resource: pending.resource
        };
        await store.updateSecret(ownerId, id, (current) => ({
            secret: { ...spend(current), client, tokens },
            result: true
        }));
    } catch {
        // A refused code leaves the pending authorization spent either way.
        await store.updateSecret(ownerId, id, (current) =>
            current?.pending?.stateHash === pending.stateHash
                ? { secret: spend(current), result: true }
                : null
        );
        return null;
    }
    await checkConnector(ownerId, id);
    return id;
}
