/**
 * What the face route serves for an address, in the order it asks.
 *
 * The colleague's own picture when the reader may see it, served directly and
 * checked by the browser on every use; their Gravatar otherwise, exactly as a
 * stranger at that address would get; the site's mark after that; and nothing,
 * so the list draws initials. A hidden picture must not change any of what a
 * stranger's address gets - not the status, not the caching.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
const GRAVATAR = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]);

let owner: string | null = null;
let photo: { etag: string; mime: string; bytes: Uint8Array | null } | null = null;
let gravatar: Uint8Array | null = null;
let resolved: string[] = [];

vi.mock("@/lib/api-session", () => ({
    apiPermission: async () => ({ id: "reader", isAdmin: false })
}));

vi.mock("@/lib/mailbox/face-owner", () => ({
    visibleOwner: async () => owner,
    addressGravatar: async () =>
        gravatar
            ? { image: { bytes: gravatar, mime: "image/png", etag: '"gface"' }, certain: true }
            : null
}));

vi.mock("@/lib/avatar-service", () => ({
    resolveAvatar: async (id: string) => {
        resolved.push(id);
        return {
            picture: photo
                ? { etag: photo.etag, mime: photo.mime, load: async () => photo!.bytes }
                : null,
            certain: true
        };
    }
}));

// No site answers, so a hunt ends in "nothing".
vi.mock("@/lib/safe-fetch", () => ({
    follow: async () => null,
    readAtMost: async () => null,
    readCapped: async () => null,
    safeUrl: () => null
}));

const { GET } = await import("../../src/app/api/mail/face/[address]/route");

function ask(address: string, headers: Record<string, string> = {}): Promise<Response> {
    return GET(
        new Request(`http://polaris.test/api/mail/face/${encodeURIComponent(address)}`, {
            headers
        }),
        {
            params: Promise.resolve({ address: encodeURIComponent(address) })
        }
    );
}

beforeEach(() => {
    owner = null;
    photo = null;
    gravatar = null;
    resolved = [];
});

describe("the face for an address", () => {
    it("serves a visible colleague's photo directly, kept only on condition", async () => {
        owner = "u1";
        photo = { etag: '"u1"', mime: "image/png", bytes: PHOTO };
        const response = await ask("one@example.test");
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(PHOTO);
        expect(response.headers.get("cache-control")).toBe("private, no-cache");
        expect(response.headers.get("etag")).toBe('"u1"');
    });

    it("answers a browser that already has the photo with a 304", async () => {
        owner = "u1";
        photo = { etag: '"u1"', mime: "image/png", bytes: PHOTO };
        const response = await ask("one@example.test", { "if-none-match": '"u1"' });
        expect(response.status).toBe(304);
    });

    it("serves a hidden colleague the way it serves a stranger", async () => {
        gravatar = GRAVATAR;
        const hidden = await ask("one@example.test");
        owner = null;
        const stranger = await ask("two@example.test");
        expect(resolved).toEqual([]);
        for (const response of [hidden, stranger]) {
            expect(response.status).toBe(200);
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(GRAVATAR);
            expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
        }
    });

    it("falls to Gravatar when the colleague has no photo", async () => {
        owner = "u1";
        gravatar = GRAVATAR;
        const response = await ask("one@example.test");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(GRAVATAR);
    });

    it("falls to Gravatar when the photo's storage is not answering", async () => {
        owner = "u1";
        photo = { etag: '"u1"', mime: "image/png", bytes: null };
        gravatar = GRAVATAR;
        const response = await ask("one@example.test");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(GRAVATAR);
    });

    it("answers nothing, privately, when no source has a picture", async () => {
        const response = await ask("nobody@unreachable.test");
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    });
});
