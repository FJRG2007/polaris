import { dirname } from "node:path";
import { CORPUS } from "../support/corpus";
import { describe, expect, it } from "vitest";
import * as probe from "../../src/domains/probe/ts";
import { allVectorFiles, loadVectors, vectorPath } from "../support/files";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { canonical, decodeValue, encodeValue, outcome, replay, type VectorFile } from "../../src/vectors";

const TWINS: Record<string, (...args: never[]) => unknown> = {
    "probe/fnv1a32": probe.fnv1a32 as (...args: never[]) => unknown,
    "probe/decodeHex": probe.decodeHex as (...args: never[]) => unknown
};

function generate(entry: (typeof CORPUS)[number]): VectorFile {
    return {
        domain: entry.domain,
        op: entry.op,
        source: entry.source,
        cases: entry.cases.map((c) => ({
            name: c.name,
            args: c.args,
            expect: outcome(() => (entry.fn as (...a: unknown[]) => unknown)(...c.args.map(decodeValue)))
        }))
    };
}

describe("golden vectors", () => {
    for (const entry of CORPUS) {
        it(`${entry.domain}/${entry.op} matches what the TypeScript implementation produces now`, () => {
            const path = vectorPath(entry.domain, entry.op);
            const text = `${JSON.stringify(generate(entry), null, 2)}\n`;
            if (process.env.UPDATE_VECTORS === "1") {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, text);
            }
            expect(existsSync(path), `${path} is missing: run npm run vectors -w @polaris/core-rs`).toBe(true);
            expect(readFileSync(path, "utf8")).toBe(text);
        });
    }

    it("every committed file has a corpus entry and a TypeScript twin", () => {
        const fromCorpus = CORPUS.map((e) => `${e.domain}/${e.op}`).sort();
        expect(allVectorFiles().map(([d, o]) => `${d}/${o}`)).toEqual(fromCorpus);
        for (const key of fromCorpus) expect(TWINS[key], key).toBeTypeOf("function");
    });

    it("the TypeScript twin replays every committed vector", () => {
        for (const [domain, op] of allVectorFiles()) {
            const fn = TWINS[`${domain}/${op}`] as (...a: unknown[]) => unknown;
            expect(replay(loadVectors(domain, op), fn), `${domain}/${op}`).toEqual([]);
        }
    });

    it("covers both outcomes in every file that can fail", () => {
        const hex = loadVectors("probe", "decodeHex");
        expect(hex.cases.some((c) => "ok" in c.expect)).toBe(true);
        expect(hex.cases.some((c) => "error" in c.expect)).toBe(true);
    });
});

describe("vector codec", () => {
    it("round-trips every tag", () => {
        const value = ["a", new Uint8Array([0, 255]), "x\ud800", [1, true, null], { b: 1, a: "\udc00" }];
        const encoded = encodeValue(value);
        expect(encoded).toEqual(["a", { $bytes: "00ff" }, { $utf16: [120, 0xd800] }, [1, true, null], { a: { $utf16: [0xdc00] }, b: 1 }]);
        expect(decodeValue(encoded)).toEqual(value);
        expect(decodeValue({ $repeat: { text: "ab", times: 3 } })).toBe("ababab");
    });

    it("refuses what the Rust loader refuses", () => {
        for (const bad of [
            { $bytes: "abc" },
            { $bytes: "AB" },
            { $bytes: "zz" },
            { $utf16: [70000] },
            { $repeat: { text: "a" } },
            { $repeat: { text: "a", times: 2, extra: 1 } },
            { $repeat: { text: "aaaa", times: 2 ** 40 } },
            { $bytes: "00", other: 1 },
            { $unknown: 1 }
        ])
            expect(() => decodeValue(bad), JSON.stringify(bad)).toThrow();
    });

    it("refuses values the format cannot carry", () => {
        for (const bad of [undefined, Number.NaN, Infinity, () => 1, 1n]) expect(() => encodeValue(bad)).toThrow();
    });

    it("describes errors by class name and message", () => {
        expect(outcome(() => probe.decodeHex("0"))).toEqual({ error: { kind: "RangeError", message: "Invalid hex string: odd length" } });
        expect(canonical({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
    });
});
