/**
 * Ignored traffic is a list of entries, not two text boxes: each change is one
 * add, edit or removal, checked by the schema the server applies, and a paste
 * adds several at once.
 */

import { describe, expect, it } from "vitest";
import { applyEntryChange, splitEntries, validEntry } from "@/app/(app)/analytics/ignored-traffic";

const empty = { excludedPaths: [], ignoredIps: [] };

describe("ignored traffic entries", () => {
    it("checks each kind with the server's own rule", () => {
        expect(validEntry("path", "/admin*")).toBe(true);
        expect(validEntry("path", "admin")).toBe(false);
        expect(validEntry("ip", "198.51.100.0/24")).toBe(true);
        expect(validEntry("ip", "2001:db8::1")).toBe(true);
        expect(validEntry("ip", "not-an-ip")).toBe(false);
    });

    it("reads a paste as separate entries, once each", () => {
        expect(splitEntries("/a\n/b, /c  /a\n\n")).toEqual(["/a", "/b", "/c"]);
    });

    it("adds, edits and removes one entry without touching the other list", () => {
        const added = applyEntryChange(empty, { op: "add", kind: "path", values: ["/admin*", "/health"] });
        expect(added).toEqual({ excludedPaths: ["/admin*", "/health"], ignoredIps: [] });
        const edited = applyEntryChange(added as typeof empty, { op: "edit", from: { kind: "path", value: "/health" }, value: "/status" });
        expect(edited).toEqual({ excludedPaths: ["/admin*", "/status"], ignoredIps: [] });
        const removed = applyEntryChange(edited as typeof empty, { op: "delete", from: { kind: "path", value: "/admin*" } });
        expect(removed).toEqual({ excludedPaths: ["/status"], ignoredIps: [] });
    });

    it("refuses a duplicate and a list past its limit", () => {
        const one = { excludedPaths: ["/a"], ignoredIps: ["10.0.0.1"] };
        expect(applyEntryChange(one, { op: "add", kind: "path", values: ["/a"] })).toBe("duplicate");
        expect(applyEntryChange(one, { op: "edit", from: { kind: "ip", value: "10.0.0.1" }, value: "10.0.0.1" })).toEqual(one);
        const many = Array.from({ length: 50 }, (_, i) => `/p${i}`);
        expect(applyEntryChange(empty, { op: "add", kind: "path", values: many })).not.toBe("tooMany");
        expect(applyEntryChange({ ...empty, excludedPaths: many }, { op: "add", kind: "path", values: ["/x"] })).toBe("tooMany");
    });
});
