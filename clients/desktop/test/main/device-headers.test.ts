/**
 * The device headers reach the server the window shows and nothing else.
 */

import { describe, expect, it } from "vitest";
import { deviceHeadersFor } from "../../src/main/device-headers";

const ID = "a".repeat(64);
const identity = { id: ID, name: "DRAGON PC", osVersion: "Windows 11 Pro" };

describe("deviceHeadersFor", () => {
    it("adds the id and the encoded name for the active server", () => {
        expect(deviceHeadersFor("https://polaris.example/api/x", "https://polaris.example", identity)).toEqual({
            "x-polaris-device": ID,
            "x-polaris-device-name": "DRAGON%20PC"
        });
    });

    it("sends nothing to another origin", () => {
        expect(deviceHeadersFor("https://elsewhere.example/", "https://polaris.example", identity)).toBeNull();
        expect(deviceHeadersFor("https://polaris.example.evil/", "https://polaris.example", identity)).toBeNull();
    });

    it("sends nothing without a server, an id or a readable address", () => {
        expect(deviceHeadersFor("https://polaris.example/", null, identity)).toBeNull();
        expect(deviceHeadersFor("https://polaris.example/", "https://polaris.example", { ...identity, id: null })).toBeNull();
        expect(deviceHeadersFor("not a url", "https://polaris.example", identity)).toBeNull();
    });
});
