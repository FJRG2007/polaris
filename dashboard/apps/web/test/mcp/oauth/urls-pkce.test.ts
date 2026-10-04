/**
 * The address rules and PKCE: the parts of the OAuth flow an attacker reaches
 * first. A redirect address that slips through is an open redirect that hands
 * somebody's authorization code to whoever registered it; a resource compared
 * loosely is a token accepted somewhere it was not issued for.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validChallenge, verifierMatches } from "@/lib/mcp/oauth/pkce";
import {
    acceptableRedirectUri,
    authorizationServerMetadata,
    canonicalResource,
    mcpResource,
    protectedResourceMetadata,
    redirectMatches,
    sameResource,
    withParams,
    wwwAuthenticate
} from "@/lib/mcp/oauth/urls";

const ORIGIN = "https://polaris.example.test";

describe("redirect addresses an app may register", () => {
    it("accepts https anywhere and http only to this computer", () => {
        expect(acceptableRedirectUri("https://claude.ai/api/mcp/auth_callback")).not.toBeNull();
        expect(acceptableRedirectUri("http://localhost:33418/callback")).not.toBeNull();
        expect(acceptableRedirectUri("http://127.0.0.1/callback")).not.toBeNull();
        expect(acceptableRedirectUri("http://[::1]:8080/cb")).not.toBeNull();
    });

    it("refuses everything an attacker would reach for", () => {
        for (const uri of [
            "http://attacker.example/callback",
            "http://localhost.attacker.example/cb",
            "http://127.0.0.1.nip.io/cb",
            "javascript:alert(1)",
            "data:text/html,hi",
            "cursor://anysphere.cursor-retrieval/oauth/callback",
            "https://user:pass@claude.ai/cb",
            "https://claude.ai/cb#fragment",
            "//claude.ai/cb",
            "/relative",
            "",
            `https://example.test/${"a".repeat(3000)}`
        ]) {
            expect(acceptableRedirectUri(uri), uri).toBeNull();
        }
    });
});

describe("matching a presented redirect address", () => {
    const registered = [
        "https://claude.ai/api/mcp/auth_callback",
        "http://localhost/callback",
        "http://127.0.0.1:33418/"
    ];

    it("matches an https address exactly and nothing near it", () => {
        expect(redirectMatches(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
        for (const near of [
            "https://claude.ai/api/mcp/auth_callback/",
            "https://claude.ai/api/mcp/auth_callback?x=1",
            "https://CLAUDE.ai/api/mcp/auth_callback",
            "https://claude.ai.attacker.example/api/mcp/auth_callback",
            "https://claude.ai/api/mcp/auth_callback/../../evil",
            "https://claude.ai:8443/api/mcp/auth_callback"
        ]) {
            expect(redirectMatches(registered, near), near).toBe(false);
        }
    });

    it("lets a loopback address arrive on any port, with the same host and path (RFC 8252)", () => {
        expect(redirectMatches(registered, "http://localhost:51234/callback")).toBe(true);
        expect(redirectMatches(registered, "http://127.0.0.1:9999/")).toBe(true);
        expect(redirectMatches(registered, "http://localhost:51234/other")).toBe(false);
        // Another loopback spelling is another registration.
        expect(redirectMatches(registered, "http://127.0.0.1:51234/callback")).toBe(false);
        // And the port leniency never extends to https.
        expect(redirectMatches(["https://claude.ai/cb"], "https://claude.ai:444/cb")).toBe(false);
    });

    it("keeps the app's own query when the answer is appended", () => {
        const url = new URL(
            withParams("https://app.example/cb?keep=1", { code: "abc", state: "s t" })
        );
        expect(url.searchParams.get("keep")).toBe("1");
        expect(url.searchParams.get("code")).toBe("abc");
        expect(url.searchParams.get("state")).toBe("s t");
    });
});

describe("the resource a token is for", () => {
    it("is the MCP endpoint on the origin the client used", () => {
        expect(mcpResource(ORIGIN)).toBe(`${ORIGIN}/api/mcp`);
        expect(mcpResource("http://localhost:3000")).toBe("http://localhost:3000/api/mcp");
    });

    it("compares the spellings a client may send and nothing else", () => {
        const expected = mcpResource(ORIGIN);
        expect(sameResource("https://POLARIS.example.test/api/mcp", expected)).toBe(true);
        expect(sameResource("https://polaris.example.test/api/mcp/", expected)).toBe(true);
        expect(sameResource("https://polaris.example.test:443/api/mcp", expected)).toBe(true);
        for (const other of [
            "https://polaris.example.test/api/mcp2",
            "https://polaris.example.test/api",
            "https://evil.example/api/mcp",
            "http://polaris.example.test/api/mcp",
            "https://polaris.example.test/api/mcp#x",
            "not a url"
        ]) {
            expect(sameResource(other, expected), other).toBe(false);
        }
        expect(canonicalResource("ftp://polaris.example.test/api/mcp")).toBeNull();
    });
});

describe("the metadata documents", () => {
    it("point the resource at this instance as its authorization server", () => {
        const resource = protectedResourceMetadata(ORIGIN, ["tasks.read"]);
        expect(resource.resource).toBe(`${ORIGIN}/api/mcp`);
        expect(resource.authorization_servers).toEqual([ORIGIN]);
        expect(resource.scopes_supported).toEqual(["tasks.read"]);
    });

    it("advertise what the MCP clients check before they proceed", () => {
        const server = authorizationServerMetadata(ORIGIN, ["tasks.read"]);
        expect(server.issuer).toBe(ORIGIN);
        expect(server.code_challenge_methods_supported).toEqual(["S256"]);
        expect(server.token_endpoint_auth_methods_supported).toContain("none");
        expect(server.client_id_metadata_document_supported).toBe(true);
        expect(server.authorization_response_iss_parameter_supported).toBe(true);
        expect(server.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
        expect(server.response_types_supported).toEqual(["code"]);
        for (const endpoint of [
            server.authorization_endpoint,
            server.token_endpoint,
            server.registration_endpoint
        ]) {
            expect(endpoint.startsWith(`${ORIGIN}/`)).toBe(true);
        }
    });

    it("challenge a 401 with where the metadata is", () => {
        expect(wwwAuthenticate(ORIGIN, ["tasks.read", "tasks.manage"])).toBe(
            `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="tasks.read tasks.manage"`
        );
        expect(wwwAuthenticate(ORIGIN, [], true)).toContain('error="invalid_token"');
    });
});

describe("PKCE", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    it("accepts the verifier the challenge was made from (RFC 7636 appendix B)", () => {
        expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        expect(verifierMatches(verifier, challenge)).toBe(true);
    });

    it("refuses any other verifier, a plain challenge, and malformed input", () => {
        expect(verifierMatches(`${verifier.slice(0, -1)}A`, challenge)).toBe(false);
        // `plain`: the challenge is the verifier itself.
        expect(verifierMatches(verifier, verifier)).toBe(false);
        expect(verifierMatches("short", challenge)).toBe(false);
        expect(verifierMatches(`${verifier} `, challenge)).toBe(false);
        expect(validChallenge("too-short")).toBe(false);
        expect(validChallenge(challenge)).toBe(true);
    });
});
