/**
 * What a deck is told about the newest plugin and Companion module: the
 * versions from the release lookup, nothing when it fails, and nothing - rather
 * than a slow catalogue - when GitHub is slow to answer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const lookups = {
    streamdeck: async (): Promise<unknown> => null,
    companion: async (): Promise<unknown> => null
};

vi.mock("@/lib/app-releases", () => ({
    streamDeckDownload: () => lookups.streamdeck(),
    companionDownload: () => lookups.companion()
}));

const { deckReleases } = await import("@/lib/deck/releases");

const release = (version: string) => ({ url: "https://github.com/x/y", version, files: [] });

beforeEach(() => {
    lookups.streamdeck = async () => null;
    lookups.companion = async () => null;
});

describe("deckReleases", () => {
    it("names the newest plugin and module and where to get them", async () => {
        lookups.streamdeck = async () => release("0.2.1");
        lookups.companion = async () => release("1.0.3");
        expect(await deckReleases("FJRG2007/polaris")).toEqual({
            streamdeck: "0.2.1",
            companion: "1.0.3",
            downloadsPath: "/account/downloads"
        });
    });

    it("says nothing about a release it could not find or look up", async () => {
        lookups.companion = async () => {
            throw new Error("offline");
        };
        expect(await deckReleases("FJRG2007/polaris")).toMatchObject({
            streamdeck: null,
            companion: null
        });
    });

    it("answers without a version that is slow to arrive, instead of waiting for it", async () => {
        lookups.streamdeck = () => new Promise(() => undefined);
        lookups.companion = async () => release("1.0.0");
        const started = Date.now();
        const answer = await deckReleases("FJRG2007/polaris", 50);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(answer).toMatchObject({ streamdeck: null, companion: "1.0.0" });
    });
});
