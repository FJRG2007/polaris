/**
 * Client ID Metadata Documents: an app named by the https address of its own
 * metadata. Read through the vetted fetch (never a private address, no
 * redirects followed), kept for a day, and refused when the document claims to
 * be somebody else.
 */

import { createFakeDb } from "./fake-db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    db: null as unknown as ReturnType<typeof import("./fake-db").createFakeDb>,
    document: null as unknown,
    status: 200,
    fetches: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    get prisma() {
        return state.db.prisma;
    }
}));
vi.mock("@/lib/safe-fetch", () => ({
    FETCH_TIMEOUT_MS: 5000,
    safeUrl: (value: string) => {
        try {
            return new URL(value);
        } catch {
            return null;
        }
    },
    configuredRequest: async (
        address: string,
        _init: unknown,
        options: { allowPrivate: boolean }
    ) => {
        expect(options.allowPrivate).toBe(false);
        state.fetches.push(address);
        return new Response(JSON.stringify(state.document), { status: state.status });
    },
    readCapped: async (response: Response) => new Uint8Array(await response.arrayBuffer())
}));

const { lookupClient, resolveClient } = await import("@/lib/mcp/oauth/clients");

const ADDRESS = "https://claude.ai/oauth/claude-code-client-metadata";

beforeEach(() => {
    state.db = createFakeDb([]);
    state.fetches = [];
    state.status = 200;
    state.document = {
        client_id: ADDRESS,
        client_name: "Claude Code",
        redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none"
    };
});

describe("a metadata-document client", () => {
    it("is read once and then kept", async () => {
        const first = await resolveClient(ADDRESS);
        expect(first?.name).toBe("Claude Code");
        expect(first?.source).toBe("metadata");
        expect(first?.redirectUris).toContain("http://localhost/callback");
        await resolveClient(ADDRESS);
        expect(state.fetches).toEqual([ADDRESS]);
    });

    it("is refused when the document names another client_id", async () => {
        state.document = { ...(state.document as object), client_id: "https://evil.example/meta" };
        expect(await resolveClient(ADDRESS)).toBeNull();
    });

    it("is refused when the address does not answer 200 (a redirect included)", async () => {
        state.status = 302;
        expect(await resolveClient(ADDRESS)).toBeNull();
    });

    it("tells a document that could not be read from one that was read and refused", async () => {
        state.status = 503;
        expect(await lookupClient(ADDRESS)).toEqual({ client: null, failure: "unreachable" });
        state.status = 200;
        state.document = { ...(state.document as object), client_id: "https://evil.example/meta" };
        expect(await lookupClient(ADDRESS)).toEqual({ client: null, failure: "rejected" });
        expect(await lookupClient("pmc_unknown")).toEqual({ client: null });
    });

    it("is never fetched for an address that is not https with a path", async () => {
        expect(await resolveClient("http://claude.ai/meta")).toBeNull();
        expect(await resolveClient("https://claude.ai/")).toBeNull();
        expect(state.fetches).toEqual([]);
    });
});

/** ChatGPT's document as https://chatgpt.com/oauth/client.json serves it. It
 *  prefers private_key_jwt but lists none among the methods it supports, and
 *  the method used is chosen from what both ends support. */
const CHATGPT = "https://chatgpt.com/oauth/client.json";
const CHATGPT_DOCUMENT = {
    client_id: CHATGPT,
    client_uri: "https://chatgpt.com/",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "ChatGPT",
    logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
    token_endpoint_auth_signing_alg: "RS256",
    jwks_uri: "https://chatgpt.com/oauth/jwks.json"
};

describe("ChatGPT's metadata document", () => {
    it("is accepted as a public client, since it supports none", async () => {
        state.document = CHATGPT_DOCUMENT;
        const client = await resolveClient(CHATGPT);
        expect(client?.name).toBe("ChatGPT");
        expect(client?.tokenAuthMethod).toBe("none");
        expect(client?.redirectUris).toEqual([
            "https://chatgpt.com/connector_platform_oauth_redirect"
        ]);
    });

    it("is refused when it supports only methods this server cannot check", async () => {
        state.document = {
            ...CHATGPT_DOCUMENT,
            token_endpoint_auth_methods_supported: ["private_key_jwt"]
        };
        expect(await resolveClient(CHATGPT)).toBeNull();
    });
});
