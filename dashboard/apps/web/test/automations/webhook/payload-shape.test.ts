/**
 * The shared payload shape: what may be saved, what it compiles to, and the
 * shape inferred from a sample.
 */

import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";

const field = (over: Partial<core.PayloadField>): core.PayloadField => ({
    name: "",
    type: "string",
    required: true,
    nullable: false,
    ...over
});
const object = (fields: core.PayloadField[], strict = true): core.PayloadShape => ({
    kind: "structured",
    root: field({ type: "object", fields, strict })
});

describe("payload shape model", () => {
    it("accepts any and a well-formed structure", () => {
        expect(core.payloadShapeSchema.safeParse({ kind: "any" }).success).toBe(true);
        expect(core.payloadShapeSchema.safeParse(object([field({ name: "a" })])).success).toBe(true);
    });
    it("refuses duplicate or empty names, enums without values, inverted ranges", () => {
        expect(core.payloadShapeSchema.safeParse(object([field({ name: "a" }), field({ name: "a" })])).success).toBe(false);
        expect(core.payloadShapeSchema.safeParse(object([field({ name: "" })])).success).toBe(false);
        expect(core.payloadShapeSchema.safeParse(object([field({ name: "e", type: "enum" })])).success).toBe(false);
        expect(core.payloadShapeSchema.safeParse(object([field({ name: "n", type: "number", min: 5, max: 1 })])).success).toBe(false);
    });
    it("bounds depth and field count", () => {
        let deep = field({ name: "x" });
        for (let i = 0; i < 8; i++) deep = field({ name: `l${i}`, type: "object", fields: [deep] });
        expect(core.payloadShapeSchema.safeParse({ kind: "structured", root: deep }).success).toBe(false);
        const many = Array.from({ length: 205 }, (_, i) => field({ name: `f${i}` }));
        expect(core.payloadShapeSchema.safeParse(object(many)).success).toBe(false);
    });
    it("refuses catastrophic-backtracking and backreference patterns", () => {
        expect(core.safePattern("^(a+)+$")).toBe(false);
        expect(core.safePattern("(x*)*")).toBe(false);
        expect(core.safePattern("(a)\\1")).toBe(false);
        expect(core.safePattern("[")).toBe(false);
        expect(core.safePattern("^[a-z0-9-]{3,20}$")).toBe(true);
        expect(core.payloadShapeSchema.safeParse(object([field({ name: "p", pattern: "(a|aa)+$".replace("|aa", "+") })])).success).toBe(false);
    });
});

describe("compileShape", () => {
    it("any accepts anything", () => {
        expect(core.checkPayload({ kind: "any" }, { whatever: [1] }).ok).toBe(true);
    });
    it("enforces each type and constraint", () => {
        const shape = object([
            field({ name: "s", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" }),
            field({ name: "i", type: "integer", min: 1, max: 10 }),
            field({ name: "n", type: "number", required: false }),
            field({ name: "b", type: "boolean" }),
            field({ name: "e", type: "enum", values: ["x", "y"] }),
            field({ name: "a", type: "array", maxLength: 2, items: field({ type: "integer" }) }),
            field({ name: "z", type: "null" }),
            field({ name: "o", type: "object", nullable: true, fields: [field({ name: "k" })] })
        ]);
        const good = { s: "abc", i: 3, b: true, e: "x", a: [1], z: null, o: null };
        expect(core.checkPayload(shape, good).ok).toBe(true);
        const fails = (change: object) => core.checkPayload(shape, { ...good, ...change });
        expect(fails({ s: "a" })).toEqual({ ok: false, path: "s" });
        expect(fails({ s: "ABC" })).toEqual({ ok: false, path: "s" });
        expect(fails({ i: 1.5 })).toEqual({ ok: false, path: "i" });
        expect(fails({ i: 11 })).toEqual({ ok: false, path: "i" });
        expect(fails({ e: "q" })).toEqual({ ok: false, path: "e" });
        expect(fails({ a: [1, 2, 3] })).toEqual({ ok: false, path: "a" });
        expect(fails({ a: ["x"] })).toEqual({ ok: false, path: "a.0" });
        expect(fails({ o: { k: 1 } })).toEqual({ ok: false, path: "o.k" });
    });
    it("strict refuses unknown keys, loose keeps them", () => {
        expect(core.checkPayload(object([field({ name: "a" })]), { a: "x", extra: 1 }).ok).toBe(false);
        expect(core.checkPayload(object([field({ name: "a" })], false), { a: "x", extra: 1 })).toEqual({
            ok: true,
            value: { a: "x", extra: 1 }
        });
    });
    it("caps the size", () => {
        const shape: core.PayloadShape = { ...object([], false), maxBytes: 10 } as core.PayloadShape;
        expect(core.checkPayload(shape, { long: "x".repeat(20) })).toEqual({ ok: false, path: "(size)" });
    });
});

describe("inferShape", () => {
    it("builds a strict shape the sample matches", () => {
        const sample = { id: 3, name: "x", price: 1.5, tags: ["a"], ok: true, meta: { at: null } };
        const shape = core.inferShape(sample);
        expect(core.payloadShapeSchema.safeParse(shape).success).toBe(true);
        expect(core.checkPayload(shape, sample).ok).toBe(true);
        expect(core.checkPayload(shape, { ...sample, extra: 1 }).ok).toBe(false);
        expect(core.checkPayload(shape, { ...sample, id: "3" }).ok).toBe(false);
        expect(core.checkPayload(shape, core.sampleForShape(shape)).ok).toBe(true);
    });
});
