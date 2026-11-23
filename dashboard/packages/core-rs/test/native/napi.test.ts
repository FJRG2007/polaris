/**
 * The real Node binding (built by `npm run build:rust`): every golden vector,
 * 10,000 random cases per property against the TypeScript twin (plan 4.2), and
 * the facade's failure injection against the real build (plan 4.5).
 */

import fc from "fast-check";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as core from "../../src/index";
import * as probe from "../../src/probe";
import * as phone from "../../src/phone";
import * as phoneTwin from "../../src/domains/phone/ts";
import { PHONE_RESET_INPUT, asVector } from "../support/phone-corpus";
import { createRequire } from "node:module";
import * as twin from "../../src/domains/probe/ts";
import { canonical, outcome, replay } from "../../src/vectors";
import { pickBinding, type CoreBinding } from "../../src/binding";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allVectorFiles, loadVectors, packageDir, requireBuilt } from "../support/files";

// The same libc test the loader makes (src/native.ts): musl Node has no glibc version.
const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
const musl = process.platform === "linux" && !report.header?.glibcVersionRuntime;
const fileName = core.nativeFileName(process.platform, process.arch, musl);
const builtPath = requireBuilt(join(packageDir, "native", fileName));
const raw = pickBinding(createRequire(import.meta.url)(builtPath));
const RUNS = 10_000;

const RAW_OPS: Record<string, (...args: unknown[]) => unknown> = {
    "probe/fnv1a32": (text) => raw.probeFnv1a32(text as string),
    "probe/decodeHex": (hex) => {
        try {
            return new Uint8Array(raw.probeDecodeHex(hex as string));
        } catch (error) {
            // A domain error carries the TypeScript class name as its code.
            const e = error as Error & { code?: string };
            const rebuilt = new Error(e.message);
            rebuilt.name = e.code ?? "missing code";
            throw rebuilt;
        }
    }
};
const FACADE_OPS: Record<string, (...args: unknown[]) => unknown> = {
    "probe/fnv1a32": (text) => probe.fnv1a32(text as string),
    "probe/decodeHex": (hex) => probe.decodeHex(hex as string),
    ...Object.fromEntries(
        Object.entries(phone).map(([op, fn]) => [`phone/${op}`, asVector(fn as (...args: never[]) => unknown) as (...args: unknown[]) => unknown])
    )
};
// The raw phone exports need the facade's conversions (null/undefined, input
// slices), so their raw replay is the facade forced onto the binding.
for (const op of Object.keys(phone)) RAW_OPS[`phone/${op}`] = FACADE_OPS[`phone/${op}`]!;

beforeEach(() => {
    core.setRecorder(null);
    core.clearRecords();
    core.setBindingSource(core.nativeSource());
});

afterEach(() => {
    core.setMode("probe", null);
    core.setMode("phone", null);
});

describe("Node binding: golden vectors", () => {
    for (const [domain, op] of allVectorFiles()) {
        it(`${domain}/${op}: the raw binding and the facade in rust mode match every vector`, () => {
            const file = loadVectors(domain, op);
            core.setMode("phone", "rust");
            if (domain === "phone") phone.toE164(PHONE_RESET_INPUT);
            expect(replay(file, RAW_OPS[`${domain}/${op}`]!)).toEqual([]);
            core.setMode("probe", "rust");
            if (domain === "phone") phone.toE164(PHONE_RESET_INPUT);
            expect(replay(file, FACADE_OPS[`${domain}/${op}`]!)).toEqual([]);
            expect(core.status().source).toBe("napi");
            expect(core.records()).toEqual([]);
        });
    }
});

describe("Node binding: property equivalence with the TypeScript twin", () => {
    const anyString = fc.oneof(fc.string({ unit: "binary" }), fc.string({ unit: "grapheme" }), fc.string({ unit: "binary-ascii" }));
    const hexish = fc.oneof(
        fc.uint8Array({ maxLength: 64 }).map((b) => Buffer.from(b).toString("hex")),
        fc.stringMatching(/^[0-9a-fA-Fg x]{0,40}$/),
        anyString
    );

    it(`fnv1a32 agrees on ${RUNS} random strings, unpaired surrogates included`, () => {
        fc.assert(
            fc.property(anyString, (text) => raw.probeFnv1a32(text) === twin.fnv1a32(text)),
            { numRuns: RUNS }
        );
    });

    it(`decodeHex agrees on ${RUNS} random inputs, outcome and message`, () => {
        fc.assert(
            fc.property(hexish, (hex) => canonical(outcome(() => RAW_OPS["probe/decodeHex"]!(hex))) === canonical(outcome(() => twin.decodeHex(hex)))),
            { numRuns: RUNS }
        );
    });
});

describe("Node binding: failure injection through the facade", () => {
    it("present: the rust path calls the binding itself", () => {
        const binding = pickBinding(createRequire(import.meta.url)(builtPath));
        const spy = vi.spyOn(binding, "probeFnv1a32");
        core.setBindingSource({ kind: "napi", load: () => binding });
        core.setMode("probe", "rust");
        expect(probe.fnv1a32("polaris")).toBe(twin.fnv1a32("polaris"));
        expect(spy).toHaveBeenCalledWith("polaris");
        expect(core.records()).toEqual([]);
    });

    it("absent: the .node file deleted", () => {
        core.setBindingSource(core.nativeSource(mkdtempSync(join(tmpdir(), "core-rs-absent-"))));
        core.setMode("probe", "rust");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(core.records()).toMatchObject([{ kind: "fallback", reason: "missing", source: "napi" }]);
    });

    it("failing to instantiate: a corrupt .node file", () => {
        const dir = mkdtempSync(join(tmpdir(), "core-rs-corrupt-"));
        writeFileSync(join(dir, fileName), "not a shared library");
        core.setBindingSource(core.nativeSource(dir));
        core.setMode("probe", "rust");
        expect(probe.decodeHex("0a")).toEqual(new Uint8Array([10]));
        expect(core.records()).toMatchObject([{ kind: "fallback", reason: "load-failed", source: "napi" }]);
    });

    it("loads from a copied directory like a deployed install", () => {
        const dir = mkdtempSync(join(tmpdir(), "core-rs-copy-"));
        copyFileSync(builtPath, join(dir, fileName));
        core.setBindingSource(core.nativeSource(dir));
        core.setMode("probe", "rust");
        expect(probe.fnv1a32("x")).toBe(twin.fnv1a32("x"));
        expect(core.status().binding).toBe("ready");
    });

    it("panicking: a real Rust panic becomes the TypeScript answer and stops the binding", () => {
        const panicking = core.defineOp({
            domain: "probe",
            op: "panicProbe",
            ts: () => "typescript",
            rust: (binding: CoreBinding) => {
                binding.probePanic();
                return "rust";
            }
        });
        core.setMode("probe", "rust");
        expect(panicking()).toBe("typescript");
        expect(core.records()).toMatchObject([{ kind: "fallback", reason: "panic", op: "panicProbe" }]);
        expect(core.status().binding).toBe("panic");
        expect(probe.fnv1a32("still works")).toBe(twin.fnv1a32("still works"));
        // The process survived the panic: the raw binding still answers.
        expect(raw.probeFnv1a32("a")).toBe(twin.fnv1a32("a"));
    });

    it("slower than its timeout: the TypeScript answer is served", () => {
        const slow = {
            ...raw,
            probeFnv1a32: (text: string) => {
                const until = performance.now() + core.DOMAINS.probe.timeoutMs + 5;
                while (performance.now() < until);
                return raw.probeFnv1a32(text) ^ 1;
            }
        };
        core.setBindingSource({ kind: "napi", load: () => slow });
        core.setMode("probe", "rust");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(core.records()).toMatchObject([{ kind: "fallback", reason: "slow" }]);
    });

    it("shadow: a planted difference on the real binding is recorded with hashes only", () => {
        core.setBindingSource({ kind: "napi", load: () => ({ ...raw, probeDecodeHex: (hex: string) => raw.probeDecodeHex(`${hex}00`) }) });
        core.setMode("probe", "shadow");
        expect(probe.decodeHex("c0ffee")).toEqual(new Uint8Array([0xc0, 0xff, 0xee]));
        const [entry] = core.records();
        expect(entry).toMatchObject({ kind: "difference", op: "decodeHex" });
        expect(JSON.stringify(entry)).not.toContain("c0ffee");
    });
});

describe("Node binding: phone property equivalence with the TypeScript twin", () => {
    const text = fc.oneof(
        fc.string({ unit: "binary" }),
        fc.string({ unit: "grapheme" }),
        fc.stringMatching(/^[+＋]?[0-9０-９٠-٩ ()-.x#;=a-z]{0,24}$/),
        fc.tuple(fc.constantFrom("+", "", "00", "011", "0"), fc.integer({ min: 1, max: 999 }), fc.stringMatching(/^[0-9]{0,14}$/)).map(([p, c, n]) => `${p}${c}${n}`)
    );
    const country = fc.oneof(fc.constant(undefined), fc.constantFrom(...phoneTwin.phoneCountries()), fc.constantFrom("", "XX", "es", "001", "toString"));
    // `undefined` and `null` are different answers here; the codec carries neither apart.
    const seen = (fn: () => unknown) => canonical(outcome(() => fn() ?? `<${String(fn())}>`));
    const same = (a: () => unknown, b: () => unknown) => expect(seen(a)).toBe(seen(b));

    beforeEach(() => core.setMode("phone", "rust"));

    it("toE164, formatPhoneAsTyped, splitPhone, formatPhoneInternational and phoneCountryOf agree (10,000 runs each)", () => {
        fc.assert(
            fc.property(text, country, (value, c) => {
                same(() => phone.toE164(value, c as never), () => phoneTwin.toE164(value, c as never));
                same(() => phone.formatPhoneAsTyped(value, c as never), () => phoneTwin.formatPhoneAsTyped(value, c as never));
                same(() => phone.splitPhone(value), () => phoneTwin.splitPhone(value));
                same(() => phone.formatPhoneInternational(value), () => phoneTwin.formatPhoneInternational(value));
                same(() => phone.phoneCountryOf(value), () => phoneTwin.phoneCountryOf(value));
            }),
            { numRuns: RUNS }
        );
        expect(core.records()).toEqual([]);
        // 50,000 calls on each side: about 3 s on a fast machine, past vitest's
        // default 5 s on the slower CI runners (macOS x64, Alpine arm64).
    }, 120_000);
});
