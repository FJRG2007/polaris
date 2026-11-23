import { describe, expect, it } from "vitest";
import type { CoreBinding } from "../../src/binding";
import { allVectorFiles, loadVectors } from "../support/files";
import { bench, percentile } from "../../src/bench";
import * as twin from "../../src/domains/probe/ts";

describe("bench", () => {
    it("takes the nearest-rank percentile", () => {
        const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
        expect(percentile(sorted, 50)).toBe(50);
        expect(percentile(sorted, 95)).toBe(95);
        expect(percentile([7], 95)).toBe(7);
        expect(() => percentile([], 50)).toThrow("no samples");
    });

    it("times every vector file on each implementation it is given", () => {
        const files = allVectorFiles().map(([domain, op]) => loadVectors(domain, op));
        const calls: string[] = [];
        const binding = {
            probeFnv1a32: (text: string) => (calls.push("fnv1a32"), twin.fnv1a32(text)),
            probeDecodeHex: (hex: string) => (calls.push("decodeHex"), twin.decodeHex(hex))
        } as unknown as CoreBinding;
        const results = bench(files, binding, 5);
        expect(results.map((r) => `${r.op}:${r.impl}`)).toEqual(files.flatMap((f) => [`${f.domain}/${f.op}:ts`, `${f.domain}/${f.op}:napi`]));
        for (const r of results) {
            expect(r.samples).toBeGreaterThanOrEqual(30);
            expect(r.p95).toBeGreaterThanOrEqual(r.median);
        }
        expect(new Set(calls)).toEqual(new Set(["fnv1a32", "decodeHex"]));
        expect(bench(files, null, 5).every((r) => r.impl === "ts")).toBe(true);
    });

    it("refuses a vector file it has no benchmark for", () => {
        expect(() => bench([{ domain: "probe", op: "nope", source: "", cases: [] }], null, 5)).toThrow("no benchmark for probe/nope");
    });
});
