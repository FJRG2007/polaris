import { describe, expect, it } from "vitest";
import {
    canonical,
    diffBodies,
    isDuplicate,
    hashOf,
    parseBody,
    prunable
} from "@/lib/restore-points/core";

describe("restore point diff", () => {
    it("says what restoring a point would bring back, take away and change", () => {
        const now = { items: { A: { value: "1" }, B: { value: "2" } } };
        const point = { items: { A: { value: "9" }, C: { value: "3" } } };
        expect(diffBodies(now, point)).toEqual([
            { item: "A", kind: "changed", fields: [{ field: "value", before: "1", after: "9" }] },
            { item: "B", kind: "removed", fields: [{ field: "value", before: "2", after: null }] },
            { item: "C", kind: "added", fields: [{ field: "value", before: null, after: "3" }] }
        ]);
    });

    it("never shows a secret in clear on either side", () => {
        const changes = diffBodies(
            { items: { KEY: { envelope: "old" } } },
            { items: { KEY: { envelope: "new" } } }
        );
        expect(changes[0]?.fields[0]).toEqual({
            field: "envelope",
            before: "********",
            after: "********"
        });
    });

    it("finds nothing to restore in a point equal to the present", () => {
        const body = { items: { A: { b: 1, a: [1, 2] } } };
        expect(diffBodies(body, { items: { A: { a: [1, 2], b: 1 } } })).toEqual([]);
    });
});

describe("restore point storage", () => {
    it("treats the same content in another key order as a duplicate", () => {
        expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
        const body = { items: { A: { x: 1, y: 2 } } };
        expect(isDuplicate(hashOf(body), { items: { A: { y: 2, x: 1 } } })).toBe(true);
        expect(isDuplicate(null, body)).toBe(false);
    });

    it("prunes past the newest kept and anything too old", () => {
        const now = new Date("2026-10-15T00:00:00Z");
        const day = 86_400_000;
        const points = [
            { id: "old", createdAt: new Date(now.getTime() - 200 * day) },
            { id: "a", createdAt: new Date(now.getTime() - 1 * day) },
            { id: "b", createdAt: new Date(now.getTime() - 2 * day) },
            { id: "c", createdAt: new Date(now.getTime() - 3 * day) }
        ];
        expect(prunable(points, now, 2).sort()).toEqual(["c", "old"]);
        expect(prunable(points, now)).toEqual(["old"]);
    });

    it("refuses a stored body that is not a snapshot", () => {
        expect(parseBody('{"items":{}}')).toEqual({ items: {} });
        expect(() => parseBody("[]")).toThrow();
        expect(() => parseBody('{"items":null}')).toThrow();
        expect(() => parseBody("null")).toThrow();
        expect(() => parseBody('{"nope":1}')).toThrow();
    });
});
