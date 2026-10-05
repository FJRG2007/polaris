/**
 * Checking an authorization request, a registration, and a client metadata
 * document - the three things an app hands Polaris before any person has said
 * yes. The order of the checks is the security property: nothing is sent to an
 * address until it is one the app registered.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
    FETCH_TIMEOUT_MS: 5000,
    safeUrl: (value: string) => {
        try {
            return new URL(value);
        } catch {
            return null;
        }
    },
    configuredRequest: vi.fn(),
    readCapped: vi.fn()
}));

const { checkAuthorizationRequest, readParams } = await import("@/lib/mcp/oauth/authorize");
const { checkMetadataDocument, checkRegistration, cleanClientName, metadataDocumentUrl } =
    await import("@/lib/mcp/oauth/clients");
const { requestedScopes } = await import("@/lib/mcp/oauth/scopes");

const ORIGIN = "https://polaris.example.test";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const SUPPORTED = ["tasks.read", "tasks.manage", "deploy.read"] as const;

const client = {
    id: "00000000-0000-7000-8000-000000000001",
    clientId: "pmc_test",
    name: "Test app",
    clientUri: null,
    redirectUris: ["https://app.example/cb", "http://localhost/callback"],
    tokenAuthMethod: "none" as const,
    secretHash: null,
    source: "registered" as const
};

const resolve = async (id: string) => (id === client.clientId ? client : null);

function params(overrides: Record<string, string | undefined> = {}) {
    return {
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: "https://app.example/cb",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        state: "xyz",
        resource: `${ORIGIN}/api/mcp`,
        scope: "tasks.read",
        ...overrides
    };
}

function check(overrides: Record<string, string | undefined> = {}) {
    return checkAuthorizationRequest(params(overrides), ORIGIN, [...SUPPORTED], resolve);
}

describe("an authorization request", () => {
    it("is accepted when everything is in order", async () => {
        const result = await check();
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        expect(result.request.redirectUri).toBe("https://app.example/cb");
        expect(result.request.resource).toBe(`${ORIGIN}/api/mcp`);
        expect(result.request.scopes).toEqual(["tasks.read"]);
    });

    it("never redirects for an unknown client or an unregistered address (no open redirect)", async () => {
        expect(await check({ client_id: "pmc_unknown" })).toEqual({
            kind: "unsafe",
            reason: "client"
        });
        expect(await check({ client_id: undefined })).toEqual({ kind: "unsafe", reason: "client" });
        // An app named by a metadata address whose document could not be had is
        // told apart, and still never redirected.
        expect(await check({ client_id: "https://app.example/oauth/client.json" })).toEqual({
            kind: "unsafe",
            reason: "clientDetails"
        });
        for (const redirect of [
            "https://attacker.example/cb",
            "https://app.example/cb/../steal",
            "https://app.example/cb?x=1",
            "javascript:alert(1)"
        ]) {
            expect(await check({ redirect_uri: redirect }), redirect).toEqual({
                kind: "unsafe",
                reason: "redirect"
            });
        }
        // And even a broken request with a bad address is not sent anywhere.
        expect(
            await check({ redirect_uri: "https://attacker.example/cb", code_challenge: undefined })
        ).toEqual({
            kind: "unsafe",
            reason: "redirect"
        });
    });

    it("requires PKCE with S256, sending the error back with state and iss", async () => {
        for (const broken of [
            { code_challenge: undefined },
            { code_challenge_method: "plain" },
            { code_challenge_method: undefined },
            { code_challenge: "short" }
        ]) {
            const result = await check(broken);
            expect(result.kind).toBe("redirect");
            if (result.kind !== "redirect") continue;
            const url = new URL(result.url);
            expect(url.origin + url.pathname).toBe("https://app.example/cb");
            expect(url.searchParams.get("error")).toBe("invalid_request");
            expect(url.searchParams.get("state")).toBe("xyz");
            expect(url.searchParams.get("iss")).toBe(ORIGIN);
            expect(url.searchParams.get("code")).toBeNull();
        }
    });

    it("refuses a token for any other resource (audience confusion)", async () => {
        for (const resource of [
            "https://other.example/api/mcp",
            `${ORIGIN}/api/v1`,
            `${ORIGIN}/api/mcp#x`
        ]) {
            const result = await check({ resource });
            expect(result.kind).toBe("redirect");
            if (result.kind === "redirect")
                expect(new URL(result.url).searchParams.get("error")).toBe("invalid_target");
        }
        // Left out, it defaults to this endpoint.
        const result = await check({ resource: undefined });
        expect(result.kind === "ok" && result.request.resource).toBe(`${ORIGIN}/api/mcp`);
    });

    it("refuses another response type", async () => {
        const result = await check({ response_type: "token" });
        expect(result.kind === "redirect" && new URL(result.url).searchParams.get("error")).toBe(
            "unsupported_response_type"
        );
    });

    it("drops a parameter that appears twice instead of picking one", async () => {
        const search = new URLSearchParams(params() as Record<string, string>);
        search.append("redirect_uri", "https://attacker.example/cb");
        const read = readParams(search);
        expect(read.redirect_uri).toBeUndefined();
        // With two registered addresses there is no default, so it stops here.
        expect(await checkAuthorizationRequest(read, ORIGIN, [...SUPPORTED], resolve)).toEqual({
            kind: "unsafe",
            reason: "redirect"
        });
    });

    it("lets a loopback redirect arrive on its run-time port", async () => {
        const result = await check({ redirect_uri: "http://localhost:49152/callback" });
        expect(result.kind).toBe("ok");
    });
});

describe("requested scopes", () => {
    it("keeps the ones on offer, drops the rest, and offers everything when none match", () => {
        expect(requestedScopes("tasks.read offline_access openid", [...SUPPORTED])).toEqual([
            "tasks.read"
        ]);
        expect(requestedScopes("users.manage system.manage", [...SUPPORTED])).toEqual([
            ...SUPPORTED
        ]);
        expect(requestedScopes(undefined, [...SUPPORTED])).toEqual([...SUPPORTED]);
    });
});

describe("dynamic client registration", () => {
    it("accepts what VS Code sends", () => {
        const result = checkRegistration({
            client_name: "Visual Studio Code",
            redirect_uris: ["http://127.0.0.1:33418", "https://vscode.dev/redirect"],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none"
        });
        expect(result.ok).toBe(true);
    });

    it("refuses unsafe redirect addresses with invalid_redirect_uri", () => {
        for (const redirect_uris of [
            ["http://attacker.example/cb"],
            ["https://ok.example/cb", "javascript:alert(1)"],
            [],
            Array.from({ length: 11 }, (_, index) => `https://ok.example/${index}`)
        ]) {
            const result = checkRegistration({ redirect_uris });
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.refusal.error).toBe("invalid_redirect_uri");
        }
    });

    it("refuses grants, response types and auth methods it does not support", () => {
        for (const body of [
            { redirect_uris: ["https://ok.example/cb"], grant_types: ["client_credentials"] },
            { redirect_uris: ["https://ok.example/cb"], grant_types: ["implicit"] },
            { redirect_uris: ["https://ok.example/cb"], response_types: ["token"] },
            {
                redirect_uris: ["https://ok.example/cb"],
                token_endpoint_auth_method: "private_key_jwt"
            },
            "not an object",
            null
        ]) {
            const result = checkRegistration(body);
            expect(result.ok, JSON.stringify(body)).toBe(false);
        }
    });

    it("keeps a name to something that can be shown", () => {
        expect(cleanClientName("  Claude‮\u0000  Code\n")).toBe("Claude Code");
        expect(cleanClientName("x".repeat(500))).toHaveLength(100);
        expect(cleanClientName(42)).toBe("");
    });
});

describe("client metadata documents", () => {
    const address = "https://claude.ai/oauth/claude-code-client-metadata";

    it("only treats an https address with a path as one", () => {
        expect(metadataDocumentUrl(address)).not.toBeNull();
        expect(metadataDocumentUrl("https://claude.ai/")).toBeNull();
        expect(metadataDocumentUrl("http://claude.ai/meta")).toBeNull();
        expect(metadataDocumentUrl("pmc_abc")).toBeNull();
        expect(metadataDocumentUrl("https://claude.ai/meta#x")).toBeNull();
    });

    it("accepts a document that names its own address", () => {
        const document = checkMetadataDocument(address, {
            client_id: address,
            client_name: "Claude Code",
            redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
            token_endpoint_auth_method: "none"
        });
        expect(document.ok && document.name).toBe("Claude Code");
    });

    it("settles the token method on one both ends support (SEP-3149)", () => {
        const base = { client_id: address, redirect_uris: ["https://a.example/cb"] };
        // ChatGPT: prefers a key, supports none as well.
        expect(
            checkMetadataDocument(address, {
                ...base,
                token_endpoint_auth_method: "private_key_jwt",
                token_endpoint_auth_methods_supported: ["none", "private_key_jwt"]
            }).ok
        ).toBe(true);
        // Only a key: nothing this server can check.
        expect(
            checkMetadataDocument(address, {
                ...base,
                token_endpoint_auth_method: "none",
                token_endpoint_auth_methods_supported: ["private_key_jwt"]
            }).ok
        ).toBe(false);
        expect(
            checkMetadataDocument(address, { ...base, token_endpoint_auth_methods_supported: [] })
                .ok
        ).toBe(false);
    });

    it("refuses one that claims to be another app, uses keys, or registers unsafe addresses", () => {
        const refusal = (body: unknown) => {
            const result = checkMetadataDocument(address, body);
            return result.ok ? null : result.reason;
        };
        expect(
            refusal({
                client_id: "https://evil.example/meta",
                redirect_uris: ["https://a.example/cb"]
            })
        ).toContain("client_id");
        expect(
            refusal({
                client_id: address,
                redirect_uris: ["https://a.example/cb"],
                token_endpoint_auth_method: "private_key_jwt"
            })
        ).toContain("private_key_jwt");
        expect(
            refusal({ client_id: address, redirect_uris: ["http://evil.example/cb"] })
        ).toContain("evil.example");
        expect(refusal("nope")).toContain("not a client metadata document");
    });
});
