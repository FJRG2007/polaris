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

const { resolveClient } = await import("@/lib/mcp/oauth/clients");

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

    it("is never fetched for an address that is not https with a path", async () => {
        expect(await resolveClient("http://claude.ai/meta")).toBeNull();
        expect(await resolveClient("https://claude.ai/")).toBeNull();
        expect(state.fetches).toEqual([]);
    });
});
