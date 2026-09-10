/**
 * Talking to the engine: one JMAP request, authenticated, over the transport.
 *
 * The engine publishes its JMAP session at `/.well-known/jmap` like every JMAP
 * server, and the session names the URL requests go to. Only its path is used:
 * the host in it is the public name clients reach the server on, and management
 * goes over the management endpoint instead (see `transport`).
 *
 * Credentials are Basic, as the engine's API documentation lists it: during
 * setup the recovery administrator Polaris pinned in the container's
 * environment, afterwards the administrator account setup created.
 */

import * as core from "@polaris/core";
import { send, MailServerUnreachable, type MailEndpoint } from "./transport";

export interface StalwartCredentials {
    readonly username: string;
    readonly password: string;
}

/** The path requests go to, remembered per endpoint for a few minutes - the
 *  session is fetched on every screen otherwise. */
const apiPaths = new Map<string, { path: string; at: number }>();
const API_PATH_TTL_MS = 5 * 60_000;

function endpointKey(endpoint: MailEndpoint): string {
    return endpoint.kind === "local" ? `local:${endpoint.host}:${endpoint.port}` : `remote:${endpoint.hostId}:${endpoint.port}`;
}

function authHeader(credentials: StalwartCredentials): string {
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`;
}

/** Whether the engine's HTTP listener answers at all, credentials aside. */
export async function engineAnswers(endpoint: MailEndpoint): Promise<boolean> {
    try {
        const answer = await send(endpoint, { method: "GET", path: "/.well-known/jmap", headers: {} });
        // 401 is an answer: the listener is up and wants a credential.
        return answer.status > 0 && answer.status < 500;
    } catch {
        return false;
    }
}

async function apiPath(endpoint: MailEndpoint, credentials: StalwartCredentials): Promise<string> {
    const key = endpointKey(endpoint);
    const cached = apiPaths.get(key);
    if (cached && Date.now() - cached.at < API_PATH_TTL_MS) return cached.path;
    const answer = await send(endpoint, {
        method: "GET",
        path: "/.well-known/jmap",
        headers: { authorization: authHeader(credentials), accept: "application/json" }
    });
    if (answer.status === 401 || answer.status === 403) throw refused(credentials);
    let path = "/jmap/";
    try {
        const session = JSON.parse(answer.body) as { apiUrl?: unknown };
        if (typeof session.apiUrl === "string" && session.apiUrl) path = new URL(session.apiUrl, "http://engine").pathname;
    } catch {
        // A session the engine did not describe falls back to its documented path.
    }
    apiPaths.set(key, { path, at: Date.now() });
    return path;
}

/** The refusal of a credential, naming which one: the administrator's is a
 *  repair, a mailbox's is that mailbox's password. */
function refused(credentials: StalwartCredentials): core.StalwartRefusal {
    return new core.StalwartRefusal(
        credentials.username.startsWith(`${core.MAIL_ADMIN_NAME}@`) || !credentials.username.includes("@")
            ? "The mail server refused Polaris's administrator credential."
            : `The mail server refused the password Polaris holds for ${credentials.username}.`,
        "unauthorized"
    );
}

export interface MailSession {
    /** The account id mail requests name. */
    readonly accountId: string;
    readonly downloadUrl: string;
}

/**
 * The JMAP session of a mailbox, as its own credential sees it: which account
 * holds its mail, and where blobs are downloaded from (RFC 8620 section 2).
 */
export async function mailSession(endpoint: MailEndpoint, credentials: StalwartCredentials): Promise<MailSession> {
    const answer = await send(endpoint, {
        method: "GET",
        path: "/.well-known/jmap",
        headers: { authorization: authHeader(credentials), accept: "application/json" }
    });
    if (answer.status === 401 || answer.status === 403) throw refused(credentials);
    let session: { primaryAccounts?: Record<string, unknown>; downloadUrl?: unknown };
    try {
        session = JSON.parse(answer.body) as typeof session;
    } catch {
        throw new MailServerUnreachable("The mail server answered with something that is not a JMAP session.");
    }
    const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
    if (typeof accountId !== "string" || typeof session.downloadUrl !== "string") {
        throw new MailServerUnreachable("The mail server's session does not offer this mailbox's mail.");
    }
    return { accountId, downloadUrl: session.downloadUrl };
}

/** Download one blob, as bytes. */
export async function download(endpoint: MailEndpoint, credentials: StalwartCredentials, path: string): Promise<Buffer> {
    const answer = await send(endpoint, { method: "GET", path, headers: { authorization: authHeader(credentials) } });
    if (answer.status === 401 || answer.status === 403) throw refused(credentials);
    if (answer.status !== 200) throw new MailServerUnreachable("The mail server would not hand that attachment over.");
    return answer.bytes;
}

/**
 * Send method calls and hand back the whole response. Refusals of individual
 * calls are read by the caller with `answerOf`/`createdId`, which throw the
 * engine's own sentence.
 */
export async function call(
    endpoint: MailEndpoint,
    credentials: StalwartCredentials,
    calls: readonly core.JmapCall[],
    request: (calls: readonly core.JmapCall[]) => core.JmapRequest = core.jmapRequest
): Promise<unknown> {
    const path = await apiPath(endpoint, credentials);
    const answer = await send(endpoint, {
        method: "POST",
        path,
        headers: {
            authorization: authHeader(credentials),
            "content-type": "application/json",
            accept: "application/json"
        },
        body: JSON.stringify(request(calls))
    });
    if (answer.status === 401 || answer.status === 403) throw refused(credentials);
    if (answer.status >= 500) throw new MailServerUnreachable("The mail server failed to answer that request.");
    try {
        return JSON.parse(answer.body) as unknown;
    } catch {
        throw new MailServerUnreachable("The mail server answered with something that is not JMAP.");
    }
}

/** Forget the remembered API path, after the engine restarted into another mode. */
export function forgetEndpoint(endpoint: MailEndpoint): void {
    apiPaths.delete(endpointKey(endpoint));
}
