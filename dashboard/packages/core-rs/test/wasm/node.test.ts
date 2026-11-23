/**
 * The real WebAssembly binding in Node (plan 4.4): every golden vector, random
 * cases against the TypeScript twin, lazy loading, and a real trap.
 * scripts/browser-parity.mjs runs the same vectors in Chromium, WebKit and Firefox.
 */

import fc from "fast-check";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as core from "../../src/index";
import * as probe from "../../src/probe";
import * as phone from "../../src/phone";
import { pathToFileURL } from "node:url";
import { replay } from "../../src/vectors";
import * as twin from "../../src/domains/probe/ts";
import type { CoreBinding } from "../../src/binding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE_RESET_INPUT, asVector } from "../support/phone-corpus";
import { allVectorFiles, loadVectors, packageDir, requireBuilt } from "../support/files";

const glueUrl = pathToFileURL(requireBuilt(join(packageDir, "wasm", "polaris_core_wasm.js"))).href;
const wasmBytes = readFileSync(requireBuilt(join(packageDir, "wasm", "polaris_core_wasm_bg.wasm")));
const raw = await core.loadWasmBinding(glueUrl, wasmBytes);

const FACADE_OPS: Record<string, (...args: unknown[]) => unknown> = {
    "probe/fnv1a32": (text) => probe.fnv1a32(text as string),
    "probe/decodeHex": (hex) => probe.decodeHex(hex as string),
    ...Object.fromEntries(
        Object.entries(phone).map(([op, fn]) => [`phone/${op}`, asVector(fn as (...args: never[]) => unknown) as (...args: unknown[]) => unknown])
    )
};

beforeEach(() => {
    core.setRecorder(null);
    core.clearRecords();
});

afterEach(() => {
    core.setMode("probe", null);
    core.setMode("phone", null);
});

describe("WebAssembly in Node", () => {
    it("matches every golden vector through the facade in rust mode", async () => {
        core.useWasm(() => core.loadWasmBinding(glueUrl, wasmBytes));
        core.setMode("probe", "rust");
        core.setMode("phone", "rust");
        expect(await core.ready()).toBe("ready");
        for (const [domain, op] of allVectorFiles()) {
            if (domain === "phone") phone.toE164(PHONE_RESET_INPUT);
            expect(replay(loadVectors(domain, op), FACADE_OPS[`${domain}/${op}`]!), `${domain}/${op}`).toEqual([]);
        }
        expect(core.status().source).toBe("wasm");
        expect(core.records()).toEqual([]);
    });

    it("is built without the phone domain, which the facade answers with TypeScript in every mode", () => {
        expect(core.DOMAINS.phone.wasm).toBe(false);
        expect(Object.keys(raw).some((name) => name.startsWith("phone"))).toBe(false);
        core.useWasm(() => core.loadWasmBinding(glueUrl, wasmBytes));
        core.setMode("phone", "rust");
        expect(phone.toE164("600 11 12 22", "ES")).toBe("+34600111222");
        expect(core.records()).toEqual([]);
    });

    it("agrees with the TypeScript twin on 10000 random strings", () => {
        fc.assert(
            fc.property(fc.string({ unit: "binary" }), (text) => raw.probeFnv1a32(text) === twin.fnv1a32(text)),
            { numRuns: 10_000 }
        );
    });

    it("fetches nothing until a Rust-backed call, and answers with TypeScript until it has arrived", async () => {
        let binding: CoreBinding | undefined;
        const load = vi.fn(async () => {
            binding = await core.loadWasmBinding(glueUrl, wasmBytes);
            vi.spyOn(binding, "probeFnv1a32");
            return binding;
        });
        core.useWasm(load);
        core.setMode("probe", "rust");
        expect(load).not.toHaveBeenCalled();
        expect(probe.fnv1a32("first")).toBe(twin.fnv1a32("first"));
        expect(load).toHaveBeenCalledTimes(1);
        expect(await core.ready()).toBe("ready");
        expect(probe.fnv1a32("second")).toBe(twin.fnv1a32("second"));
        expect(binding!.probeFnv1a32).toHaveBeenCalledWith("second");
        expect(binding!.probeFnv1a32).not.toHaveBeenCalledWith("first");
    });

    it("a real trap becomes the TypeScript answer and the instance is dropped", async () => {
        core.useWasm(() => core.loadWasmBinding(glueUrl, wasmBytes));
        await core.ready();
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
        expect(core.records()).toMatchObject([{ kind: "fallback", reason: "panic", source: "wasm" }]);
        expect(core.status().binding).toBe("panic");
        expect(probe.decodeHex("ff")).toEqual(new Uint8Array([255]));
    });

    it("a module that does not load falls back", async () => {
        // A fresh glue instance: the shared one is already initialised and would ignore the bytes.
        core.useWasm(() => core.loadWasmBinding(`${glueUrl}?broken`, new Uint8Array([0, 1, 2, 3])));
        core.setMode("probe", "rust");
        expect(await core.ready()).toBe("load-failed");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(core.records()).toMatchObject([{ kind: "fallback", reason: "load-failed", source: "wasm" }]);
    });
});
