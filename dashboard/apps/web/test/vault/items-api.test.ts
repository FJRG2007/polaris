/**
 * The item endpoints, where a request becomes a call.
 *
 * Pinned here because the path and the body disagree about where a bulk move is
 * going: `api/ciphers/move` captures nothing, so a destination read off the path
 * is always absent and every move quietly lands in "no folder". The folder is in
 * the body, beside the ids, and that is what has to be read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "018f2b7a-0000-7000-8000-0000000000d1";
const CIPHER = "018f2b7a-0000-7000-8000-0000000000d2";
const FOLDER = "018f2b7a-0000-7000-8000-0000000000d3";
const OTHER_FOLDER = "018f2b7a-0000-7000-8000-0000000000d4";

const move = vi.fn(async () => undefined);

vi.mock("@/lib/vault/ciphers", () => ({
    moveCiphers: move,
    listCiphers: vi.fn(async () => []),
    getCipher: vi.fn(async () => null),
    createCipher: vi.fn(async () => null),
    updateCipher: vi.fn(async () => ({ ok: false, reason: "not_found" })),
    shareCipher: vi.fn(async () => ({ ok: false, reason: "not_found" })),
    deleteCiphers: vi.fn(async () => 0),
    restoreCiphers: vi.fn(async () => 0),
    purgeCiphers: vi.fn(async () => undefined)
}));
vi.mock("@/lib/vault/folders", () => ({
    listFolders: vi.fn(async () => []),
    createFolder: vi.fn(async () => ({})),
    updateFolder: vi.fn(async () => null),
    deleteFolder: vi.fn(async () => false)
}));
vi.mock("@/lib/vault/account", () => ({ verifyMasterPassword: vi.fn(async () => false) }));
vi.mock("@/lib/vault/auth", () => ({
    vaultError: (message: string, status: number) =>
        Response.json({ message, object: "error" }, { status })
}));

const items = await import("../../src/lib/vault/api/items");

/** A bearer request carrying a JSON body, as the router builds it. */
function context(body: unknown, params: Record<string, string> = {}) {
    return {
        request: new Request("https://polaris.test/vault/api/ciphers/move", {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" }
        }),
        params,
        principal: { userId: USER, email: "someone@polaris.test", device: null },
        query: new URLSearchParams()
    };
}

beforeEach(() => vi.clearAllMocks());

describe("moveCiphers", () => {
    it("moves into the folder named in the body", async () => {
        const response = await items.moveCiphers(context({ ids: [CIPHER], folderId: FOLDER }));
        expect(response.status).toBe(200);
        expect(move).toHaveBeenCalledWith(USER, [CIPHER], FOLDER);
    });

    it("reads the folder from the body even when the path carries one", async () => {
        await items.moveCiphers(
            context({ ids: [CIPHER], folderId: FOLDER }, { folderId: OTHER_FOLDER })
        );
        expect(move).toHaveBeenCalledWith(USER, [CIPHER], FOLDER);
    });

    it("takes an absent folder as no folder", async () => {
        await items.moveCiphers(context({ ids: [CIPHER] }));
        expect(move).toHaveBeenCalledWith(USER, [CIPHER], null);
    });

    it("takes an explicit null as no folder", async () => {
        await items.moveCiphers(context({ ids: [CIPHER], folderId: null }));
        expect(move).toHaveBeenCalledWith(USER, [CIPHER], null);
    });

    it("refuses a request with no items", async () => {
        const response = await items.moveCiphers(context({ ids: [] }));
        expect(response.status).toBe(400);
        expect(move).not.toHaveBeenCalled();
    });

    it("refuses ids that are not item ids", async () => {
        const response = await items.moveCiphers(context({ ids: ["not-an-id"] }));
        expect(response.status).toBe(400);
        expect(move).not.toHaveBeenCalled();
    });
});
