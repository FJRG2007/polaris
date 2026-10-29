/**
 * The kept API keys, one per server. A file written before there was more than
 * one server holds a single `{ server, key }`, which reads as a list of one.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "" }, safeStorage: {} }));

const { readStoredKeys } = await import("../../src/main/api-key-store");

describe("kept API keys", () => {
    it("reads the old single key as the key for its server", () => {
        expect(readStoredKeys(JSON.stringify({ server: "https://a.example.com", key: "k1" }))).toEqual({
            "https://a.example.com": "k1"
        });
    });

    it("reads one key per server and drops anything that is not one", () => {
        expect(
            readStoredKeys(JSON.stringify({ keys: { "https://a.example.com": "k1", "https://b.example.com": 2 } }))
        ).toEqual({ "https://a.example.com": "k1" });
        expect(readStoredKeys("not json")).toEqual({});
        expect(readStoredKeys("[]")).toEqual({});
    });
});
