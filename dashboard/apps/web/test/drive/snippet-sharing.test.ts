/**
 * Turning a snippet's link on and off.
 *
 * Three properties matter here, and all three are about a link outliving the
 * decision that created it. A snippet re-shared after being revoked gets a NEW
 * token, so somebody told to forget a link does not get it back when the owner
 * shares the snippet with a colleague. Making it private revokes it rather than
 * only relabelling the row. And burn-after-reading is stored as a view cap of
 * one, so the serving path has a single thing to check rather than two rules
 * that can disagree.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";
const SNIPPET = "018f2b7a-0000-7000-8000-0000000000b1";

const findFirst = vi.fn();
const update = vi.fn(async () => ({}));
const create = vi.fn(async () => ({ id: SNIPPET }));
const inviteDelete = vi.fn(async () => ({ count: 0 }));
const inviteCreate = vi.fn(async () => ({ count: 0 }));
const findMany = vi.fn(async () => [] as { id: string }[]);

const tx = {
    snippet: { update },
    snippetInvite: { deleteMany: inviteDelete, createMany: inviteCreate },
    snippetFile: { deleteMany: vi.fn(), createMany: vi.fn() }
};

vi.mock("@polaris/db", () => ({
    prisma: {
        snippet: { findFirst, create, update, fields: { viewCount: 0 } },
        user: { findMany },
        $transaction: async (run: (client: typeof tx) => Promise<void>) => run(tx)
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: (value: string) => ({
        ciphertext: Buffer.from(value),
        nonce: Buffer.from("n"),
        keyId: "id"
    }),
    decryptSecret: (blob: { ciphertext: Buffer }) => blob.ciphertext.toString()
}));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://polaris.test" }));

const { createSnippet, shareSnippet } = await import("../../src/lib/snippet-service");

beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([]);
});

/** The `data` the last snippet.update was called with. */
function lastUpdate(): Record<string, unknown> {
    return (update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }).data;
}

describe("createSnippet", () => {
    it("mints no token at all for a private snippet", async () => {
        const result = await createSnippet(OWNER, {
            visibility: "private",
            clientSealed: false,
            burnAfterRead: false,
            inviteUsers: [],
            allowedCidrs: [],
            allowedCountries: [],
            allowedContinents: [],
            files: [{ name: "a.txt", language: "", body: "hello" }]
        });
        expect(result.token).toBeNull();
        const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
        expect(data.tokenHash).toBeUndefined();
    });

    it("stores burn-after-reading as a cap of one view", async () => {
        await createSnippet(OWNER, {
            visibility: "link",
            clientSealed: false,
            burnAfterRead: true,
            // Deliberately contradictory: a cap of nine and burn on. Burning wins,
            // because it is the stricter of the two and the one somebody asked for.
            maxViews: 9,
            inviteUsers: [],
            allowedCidrs: [],
            allowedCountries: [],
            allowedContinents: [],
            files: [{ name: "a.txt", language: "", body: "hello" }]
        });
        const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
        expect(data.maxViews).toBe(1);
        expect(data.burnAfterRead).toBe(true);
    });

    it("names an untitled snippet after its first file", async () => {
        await createSnippet(OWNER, {
            visibility: "private",
            clientSealed: false,
            burnAfterRead: false,
            inviteUsers: [],
            allowedCidrs: [],
            allowedCountries: [],
            allowedContinents: [],
            files: [{ name: ".env.production", language: "", body: "A=1" }]
        });
        const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
        expect(data.title).toBe(".env.production");
    });
});

describe("shareSnippet", () => {
    it("refuses a snippet that is not the caller's", async () => {
        findFirst.mockResolvedValueOnce(null);
        expect(await shareSnippet(OWNER, SNIPPET, { visibility: "link" })).toEqual({ ok: false });
    });

    it("mints a token the first time a private snippet is shared", async () => {
        findFirst.mockResolvedValueOnce({
            visibility: "private",
            tokenHash: null,
            revokedAt: null
        });
        const result = await shareSnippet(OWNER, SNIPPET, { visibility: "link" });
        expect(result).toEqual({
            ok: true,
            url: expect.stringContaining("https://polaris.test/p/")
        });
        expect(lastUpdate().tokenHash).toEqual(expect.any(String));
    });

    it("mints a NEW token when a revoked snippet is shared again", async () => {
        findFirst.mockResolvedValueOnce({
            visibility: "link",
            tokenHash: "the-old-hash",
            revokedAt: new Date("2026-01-01T00:00:00Z")
        });
        await shareSnippet(OWNER, SNIPPET, { visibility: "link" });
        const data = lastUpdate();
        expect(data.tokenHash).not.toBe("the-old-hash");
        // And the counters start again with it, so the old link's spent views do
        // not exhaust the new one.
        expect(data.revokedAt).toBeNull();
        expect(data.viewCount).toBe(0);
    });

    it("keeps the token when a live link is only being re-configured", async () => {
        findFirst.mockResolvedValueOnce({ visibility: "link", tokenHash: "keep", revokedAt: null });
        findFirst.mockResolvedValueOnce({
            encryptedToken: Buffer.from("raw-token"),
            tokenNonce: Buffer.from("n"),
            tokenKeyId: "id"
        });
        const result = await shareSnippet(OWNER, SNIPPET, { maxViews: 5 });
        expect(lastUpdate().tokenHash).toBeUndefined();
        expect(result).toEqual({ ok: true, url: "https://polaris.test/p/raw-token" });
    });

    it("revokes the link when the snippet is made private", async () => {
        findFirst.mockResolvedValueOnce({ visibility: "link", tokenHash: "x", revokedAt: null });
        const result = await shareSnippet(OWNER, SNIPPET, { visibility: "private" });
        expect(result).toEqual({ ok: true, url: null });
        expect(lastUpdate().revokedAt).toBeInstanceOf(Date);
    });

    it("turning burning on overrides a view cap sent with it", async () => {
        findFirst.mockResolvedValueOnce({ visibility: "link", tokenHash: null, revokedAt: null });
        await shareSnippet(OWNER, SNIPPET, {
            visibility: "link",
            burnAfterRead: true,
            maxViews: 20
        });
        expect(lastUpdate().maxViews).toBe(1);
    });

    it("replaces the invitation list with the accounts it could place", async () => {
        findFirst.mockResolvedValueOnce({ visibility: "link", tokenHash: null, revokedAt: null });
        // Two names typed, one of which matches nobody: the four-out-of-five rule.
        findMany.mockResolvedValueOnce([{ id: "user-1" }]);
        await shareSnippet(OWNER, SNIPPET, {
            visibility: "invite",
            inviteUsers: ["ana", "nobody"]
        });
        expect(inviteDelete).toHaveBeenCalled();
        expect(inviteCreate).toHaveBeenCalledWith({
            data: [{ snippetId: SNIPPET, userId: "user-1" }]
        });
    });
});
