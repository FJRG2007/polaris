import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as oauth from "@/lib/polar/connectors/oauth";

const SERVER = "https://mcp.example.com/mcp";
const ISSUER = "https://auth.example.com/tenant";
const REDIRECT = "https://polaris.example.test/api/polar/connectors/oauth/callback";
const CONNECTOR = "0190a000-0000-7000-8000-000000000001";

interface Seen {
    url: string;
    method: string;
    headers: Headers;
    body: string;
}

/** A fake MCP server and authorization server, answering only what the spec says. */
function fakeServers(
    overrides: { pkce?: string[] | null; registration?: boolean; challenge?: boolean } = {}
) {
    const seen: Seen[] = [];
    const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
            status,
            headers: { "content-type": "application/json" }
        });
    const fetch: oauth.ConnectorFetch = async (url, init = {}) => {
        const body = typeof init.body === "string" ? init.body : "";
        seen.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body });
        if (url === SERVER) {
            return new Response("", {
                status: 401,
                headers:
                    overrides.challenge === false
                        ? {}
                        : {
                              "www-authenticate":
                                  'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read write"'
                          }
            });
        }
        if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
            return json({
                resource: SERVER,
                authorization_servers: [ISSUER],
                scopes_supported: ["read"]
            });
        }
        if (url === "https://auth.example.com/.well-known/oauth-authorization-server/tenant") {
            return json({}, 404);
        }
        if (url === "https://auth.example.com/.well-known/openid-configuration/tenant") {
            return json({
                issuer: ISSUER,
                authorization_endpoint: `${ISSUER}/authorize`,
                token_endpoint: `${ISSUER}/token`,
                ...(overrides.registration === false
                    ? {}
                    : { registration_endpoint: `${ISSUER}/register` }),
                ...(overrides.pkce === null
                    ? {}
                    : { code_challenge_methods_supported: overrides.pkce ?? ["S256"] })
            });
        }
        if (url === `${ISSUER}/register`) return json({ client_id: "dyn-client" }, 201);
        if (url === `${ISSUER}/token`) {
            const form = new URLSearchParams(body);
            if (form.get("grant_type") === "refresh_token") {
                return json({ access_token: "access-2", token_type: "Bearer", expires_in: 3600 });
            }
            return json({
                access_token: "access-1",
                token_type: "Bearer",
                expires_in: 3600,
                refresh_token: "refresh-1"
            });
        }
        return json({}, 404);
    };
    return { fetch, seen };
}

describe("connector OAuth", () => {
    it("discovers, registers, and sends the person off with PKCE, state and resource", async () => {
        const { fetch, seen } = fakeServers();
        const { authorizationUrl, pending } = await oauth.beginAuthorization(fetch, {
            connectorId: CONNECTOR,
            server: SERVER,
            redirectUri: REDIRECT,
            registered: null,
            now: 1_000
        });
        const url = new URL(authorizationUrl);
        expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
        expect(url.searchParams.get("client_id")).toBe("dyn-client");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("resource")).toBe(SERVER);
        // The challenge's scope wins over scopes_supported.
        expect(url.searchParams.get("scope")).toBe("read write");
        const challenge = createHash("sha256").update(pending.verifier).digest("base64url");
        expect(url.searchParams.get("code_challenge")).toBe(challenge);
        const state = url.searchParams.get("state")!;
        expect(oauth.stateConnectorId(state)).toBe(CONNECTOR);
        expect(pending.stateHash).toBe(oauth.hashState(state));
        expect(JSON.stringify(pending)).not.toContain(state);
        const registration = seen.find((entry) => entry.url.endsWith("/register"))!;
        expect(JSON.parse(registration.body).redirect_uris).toEqual([REDIRECT]);

        const tokens = await oauth.finishAuthorization(fetch, pending, {
            state,
            code: "the-code",
            now: 2_000
        });
        expect(tokens).toEqual({
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresAt: 3_602_000
        });
        const exchange = new URLSearchParams(seen.at(-1)!.body);
        expect(exchange.get("code_verifier")).toBe(pending.verifier);
        expect(exchange.get("resource")).toBe(SERVER);
        expect(exchange.get("client_id")).toBe("dyn-client");

        const refreshed = await oauth.refreshTokens(fetch, pending, "refresh-1", 5_000);
        expect(refreshed.refreshToken).toBe("refresh-1");
        expect(new URLSearchParams(seen.at(-1)!.body).get("resource")).toBe(SERVER);
    });

    it("refuses a callback whose state does not match or came too late", async () => {
        const { fetch } = fakeServers();
        const { authorizationUrl, pending } = await oauth.beginAuthorization(fetch, {
            connectorId: CONNECTOR,
            server: SERVER,
            redirectUri: REDIRECT,
            registered: null,
            now: 0
        });
        const state = new URL(authorizationUrl).searchParams.get("state")!;
        await expect(
            oauth.finishAuthorization(fetch, pending, { state: `${state}x`, code: "c", now: 1 })
        ).rejects.toThrow(oauth.ConnectorAuthError);
        await expect(
            oauth.finishAuthorization(fetch, pending, {
                state,
                code: "c",
                now: oauth.PENDING_TTL_MS + 1
            })
        ).rejects.toThrow(oauth.ConnectorAuthError);
    });

    it("refuses an authorization server without PKCE S256", async () => {
        for (const pkce of [null, ["plain"]]) {
            const { fetch } = fakeServers({ pkce });
            await expect(oauth.discover(fetch, SERVER)).rejects.toMatchObject({ code: "no_pkce" });
        }
    });

    it("falls back to the well-known address, and uses a client registered by hand", async () => {
        const { fetch, seen } = fakeServers({ challenge: false, registration: false });
        await expect(
            oauth.beginAuthorization(fetch, {
                connectorId: CONNECTOR,
                server: SERVER,
                redirectUri: REDIRECT,
                registered: null
            })
        ).rejects.toMatchObject({ code: "no_registration" });
        expect(seen.some((entry) => entry.url.endsWith("/oauth-protected-resource/mcp"))).toBe(
            true
        );
        const { pending } = await oauth.beginAuthorization(fetch, {
            connectorId: CONNECTOR,
            server: SERVER,
            redirectUri: REDIRECT,
            registered: { clientId: "mine", clientSecret: "s3cret" }
        });
        expect(pending.authMethod).toBe("client_secret_basic");
    });

    it("reads challenges and the discovery order of the spec", () => {
        expect(oauth.parseChallenge('Bearer error="insufficient_scope", scope="a b"')).toEqual({
            resourceMetadata: null,
            scope: "a b",
            error: "insufficient_scope"
        });
        expect(oauth.serverMetadataUrls("https://auth.example.com")).toEqual([
            "https://auth.example.com/.well-known/oauth-authorization-server",
            "https://auth.example.com/.well-known/openid-configuration"
        ]);
        expect(oauth.resourceMetadataUrls("https://x.example.com")).toEqual([
            "https://x.example.com/.well-known/oauth-protected-resource"
        ]);
        expect(oauth.resourceCovers("https://x.example.com/mcp", "https://x.example.com/mcp")).toBe(
            true
        );
        expect(oauth.resourceCovers("https://y.example.com/mcp", "https://x.example.com/mcp")).toBe(
            false
        );
        expect(oauth.tokenExpiring({ expiresAt: 100_000 }, 50_000)).toBe(true);
        expect(oauth.tokenExpiring({ expiresAt: null })).toBe(false);
    });
});
