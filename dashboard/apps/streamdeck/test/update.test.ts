/**
 * A plugin installed from a file never updates itself, so it compares its own
 * version with the newest release its Polaris names and offers the Downloads
 * page when that one is newer.
 */

import { describe, expect, it } from "vitest";
import { isNewer, updateFor } from "../src/update";
import { PolarisClient, readReleases } from "../src/polaris";

const LATEST = { streamdeck: "0.1.4", companion: "1.0.0", downloadsPath: "/account/downloads" };
const ADDRESS = "https://polaris.example.com";

describe("isNewer", () => {
    it("compares a release with the manifest's four-part version", () => {
        expect(isNewer("0.1.4", "0.1.3.0")).toBe(true);
        expect(isNewer("0.1.4", "0.1.4.0")).toBe(false);
        expect(isNewer("0.1.4", "0.2.0.0")).toBe(false);
        expect(isNewer("0.1.10", "0.1.9.0")).toBe(true);
        expect(isNewer("1.0.0", "0.9.99")).toBe(true);
    });

    it("is no update when either side does not read as numbers", () => {
        expect(isNewer(null, "0.1.0.0")).toBe(false);
        expect(isNewer("", "0.1.0.0")).toBe(false);
        expect(isNewer("0.2.0-rc.1", "0.1.0.0")).toBe(false);
        expect(isNewer("0.2.0", "dev")).toBe(false);
    });
});

describe("updateFor", () => {
    it("names the newer version and the Downloads page of the Polaris it is connected to", () => {
        expect(updateFor(LATEST, "0.1.0.0", ADDRESS)).toEqual({
            version: "0.1.4",
            url: "https://polaris.example.com/account/downloads"
        });
    });

    it("offers nothing when this is the newest, nothing is known, or there is no address", () => {
        expect(updateFor(LATEST, "0.1.4.0", ADDRESS)).toBeNull();
        expect(updateFor(null, "0.1.0.0", ADDRESS)).toBeNull();
        expect(updateFor({ ...LATEST, streamdeck: null }, "0.1.0.0", ADDRESS)).toBeNull();
        expect(updateFor(LATEST, "0.1.0.0", null)).toBeNull();
    });

    it("never offers a link that leaves the Polaris it is connected to", () => {
        expect(updateFor({ ...LATEST, downloadsPath: "//evil.example" }, "0.1.0.0", ADDRESS)).toBeNull();
        expect(
            updateFor({ ...LATEST, downloadsPath: "https://evil.example/x" }, "0.1.0.0", ADDRESS)
        ).toBeNull();
    });
});

describe("the catalogue's releases", () => {
    it("keeps them only when they have the expected shape", () => {
        expect(readReleases(LATEST)).toEqual(LATEST);
        expect(readReleases({ streamdeck: 4, downloadsPath: "/account/downloads" })).toEqual({
            streamdeck: null,
            companion: null,
            downloadsPath: "/account/downloads"
        });
        expect(readReleases(undefined)).toBeNull();
        expect(readReleases({ streamdeck: "0.1.4" })).toBeNull();
    });

    it("arrive with the catalogue, and are null from a Polaris older than the field", async () => {
        const answer = (body: unknown) =>
            new PolarisClient("0.1.0", (async () => Response.json(body)) as unknown as typeof fetch);
        const credentials = { address: ADDRESS, token: "plk_x" };
        expect(await answer({ actions: [], latest: LATEST }).listing(credentials)).toEqual({
            actions: [],
            latest: LATEST
        });
        expect(await answer({ actions: [{ id: "chat.unread" }] }).listing(credentials)).toEqual({
            actions: [{ id: "chat.unread" }],
            latest: null
        });
    });
});
