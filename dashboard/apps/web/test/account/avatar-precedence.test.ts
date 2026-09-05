/**
 * Which picture a face actually shows.
 *
 * There are three possible answers for one account - the photo it uploaded here,
 * the picture the account it signed in with has, and a Gravatar for its address
 * - and the whole of this is which one wins. Getting it wrong was a bug people
 * reported as something else entirely: they deleted their photo and it kept
 * being drawn. It was not being drawn from the row they had just emptied; the
 * picture their sign-in provider had was being put straight into an `<img>` by
 * the pages that draw faces, so it had been outranking their own photo all
 * along, and taking that photo down simply revealed it.
 *
 * So the order is pinned here, at the one place that decides it. Everything that
 * draws a face asks the route, the route asks this, and no view is allowed to
 * hold an opinion of its own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** A one-pixel PNG, so what comes back is a real picture rather than a shape. */
const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);

let uploaded: { connectionId: string | null; path: string; mime: string; updatedAt: Date } | null = null;
let account: { email: string; image: string | null } = { email: "ada@example.test", image: null };
let gravatarOn = true;
/** URLs the guarded fetcher was asked for, so "was the provider asked at all"
 *  can be asserted rather than inferred. */
let asked: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        userAvatar: { findUnique: async () => uploaded },
        user: { findUnique: async () => account }
    }
}));

vi.mock("@/lib/storage-service", () => ({
    getDriver: async () => ({
        readStream: async () => ({ on: () => undefined }),
        dispose: async () => undefined
    })
}));

vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => (gravatarOn ? null : "off"),
    setSetting: async () => undefined
}));

vi.mock("@/lib/safe-fetch", () => ({
    fetchImage: async (url: string) => {
        asked.push(url);
        return { name: "picture", contentType: "image/png", bytes: PNG };
    }
}));

const { resolveAvatar } = await import("../../src/lib/avatar-service");

beforeEach(() => {
    vi.clearAllMocks();
    uploaded = null;
    account = { email: "ada@example.test", image: null };
    gravatarOn = true;
    asked = [];
});

describe("the order the sources are asked in", () => {
    it("serves the photo somebody uploaded here, and asks nobody else", async () => {
        uploaded = { connectionId: null, path: "avatars/user-x.png", mime: "image/png", updatedAt: new Date() };
        account = { email: "ada@example.test", image: "https://provider.test/ada.png" };
        const answer = await resolveAvatar("ada");
        expect(answer.picture).not.toBeNull();
        expect(answer.certain).toBe(true);
        // The point of the whole change: a provider's picture is not consulted
        // while there is one of their own to serve.
        expect(asked).toEqual([]);
    });

    it("falls through to the picture their sign-in account has", async () => {
        account = { email: "ada@example.test", image: "https://provider.test/ada.png" };
        const answer = await resolveAvatar("ada");
        expect(answer.picture).not.toBeNull();
        expect(asked).toEqual(["https://provider.test/ada.png"]);
    });

    it("fetches that picture itself rather than pointing a browser at it", async () => {
        // An <img> aimed at the provider would tell them who is looking at whom,
        // on every screen with a face on it - the same reason Gravatar is asked
        // by Polaris and never by the page.
        account = { email: "ada@example.test", image: "https://provider.test/ada.png" };
        const answer = await resolveAvatar("ada");
        const bytes = await answer.picture?.load();
        expect(bytes).toEqual(PNG);
    });

    it("asks for it once and remembers, however many faces are on the page", async () => {
        account = { email: "ada@example.test", image: "https://provider.test/repeat.png" };
        await resolveAvatar("ada");
        await resolveAvatar("ada");
        expect(asked).toHaveLength(1);
    });

    it("has nothing to serve for an account with none of the three", async () => {
        gravatarOn = false;
        const answer = await resolveAvatar("ada");
        expect(answer.picture).toBeNull();
        // Certain, so a browser may cache the absence: this is a fact about the
        // account rather than a lookup that failed.
        expect(answer.certain).toBe(true);
    });

    it("has nothing to serve for an account that is not there", async () => {
        account = null as unknown as { email: string; image: string | null };
        const answer = await resolveAvatar("nobody");
        expect(answer.picture).toBeNull();
    });
});
