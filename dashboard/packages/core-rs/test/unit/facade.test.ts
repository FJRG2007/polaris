/**
 * The facade's modes, shadow records and fallback (plan 3.3 and 4.5), driven
 * through a binding written in JavaScript so every failure can be produced on
 * demand. test/native and test/wasm repeat the failure cases against the real
 * Rust builds.
 */

import * as core from "../../src/index";
import * as probe from "../../src/probe";
import * as twin from "../../src/domains/probe/ts";
import { DOMAIN_EXPORTS, type CoreBinding } from "../../src/binding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The phone exports, present so the binding is complete; these tests drive the probe domain only. */
const unusedPhone = Object.fromEntries(
    DOMAIN_EXPORTS.phone.map((name) => [
        name,
        () => {
            throw new Error(`${name} is not under test here`);
        }
    ])
) as unknown as Pick<CoreBinding, (typeof DOMAIN_EXPORTS.phone)[number]>;

function jsBinding(overrides: Partial<CoreBinding> = {}): CoreBinding {
    const coded = (error: Error) => Object.assign(new Error(error.message), { code: error.name });
    return {
        ...unusedPhone,
        probeFnv1a32: vi.fn((text: string) => twin.fnv1a32(text)),
        probeDecodeHex: vi.fn((hex: string) => {
            try {
                return twin.decodeHex(hex);
            } catch (error) {
                throw coded(error as Error);
            }
        }),
        probePanic: vi.fn(() => {
            throw new Error("panicked");
        }),
        ...overrides
    };
}

function inject(binding: CoreBinding | (() => CoreBinding | Promise<CoreBinding>)) {
    const load = vi.fn(typeof binding === "function" ? binding : () => binding);
    core.setBindingSource({ kind: "test", load });
    return load;
}

const fallbacks = () => core.records().filter((r) => r.kind === "fallback");

beforeEach(() => {
    core.setRecorder(null);
    core.clearRecords();
});

afterEach(() => {
    core.setMode("probe", null);
    vi.unstubAllEnvs();
});

describe("ts mode", () => {
    it("is the default and never touches the binding", () => {
        const binding = jsBinding();
        const load = inject(binding);
        expect(core.getMode("probe")).toBe("ts");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(load).not.toHaveBeenCalled();
        expect(core.records()).toEqual([]);
    });
});

describe("rust mode", () => {
    it("answers from the binding", () => {
        const binding = jsBinding({ probeFnv1a32: vi.fn(() => 42) });
        inject(binding);
        core.setMode("probe", "rust");
        expect(probe.fnv1a32("abc")).toBe(42);
        expect(binding.probeFnv1a32).toHaveBeenCalledWith("abc");
        expect(core.status().binding).toBe("ready");
    });

    it("rebuilds the TypeScript error class and message from a domain error", () => {
        const binding = jsBinding();
        inject(binding);
        core.setMode("probe", "rust");
        expect(() => probe.decodeHex("0g")).toThrow(new RangeError("Invalid hex string at index 1"));
        try {
            probe.decodeHex("abc");
        } catch (error) {
            expect(error).toBeInstanceOf(RangeError);
            expect(Object.getPrototypeOf(error)).toBe(RangeError.prototype);
        }
        expect(binding.probeDecodeHex).toHaveBeenCalledTimes(2);
        expect(fallbacks()).toEqual([]);
    });

    it("returns a plain Uint8Array even when the binding hands back a Buffer", () => {
        inject(jsBinding({ probeDecodeHex: () => Buffer.from([1, 2]) }));
        core.setMode("probe", "rust");
        const bytes = probe.decodeHex("0102");
        expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
        expect([...bytes]).toEqual([1, 2]);
    });

    it("follows POLARIS_CORE_RS_FORCE when no mode was set on the instance", () => {
        const binding = jsBinding({ probeFnv1a32: vi.fn(() => 7) });
        inject(binding);
        vi.stubEnv("POLARIS_CORE_RS_FORCE", "rust");
        expect(probe.fnv1a32("x")).toBe(7);
        vi.stubEnv("POLARIS_CORE_RS_FORCE", "bogus");
        expect(probe.fnv1a32("x")).toBe(twin.fnv1a32("x"));
    });

    it("refuses an unknown domain or mode", () => {
        expect(() => core.setMode("nope" as "probe", "rust")).toThrow();
        expect(() => core.setMode("probe", "fast" as "rust")).toThrow();
    });
});

describe("fallback to TypeScript", () => {
    it("when there is no binding at all", () => {
        core.setBindingSource(null);
        core.setMode("probe", "rust");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(probe.fnv1a32("abd")).toBe(twin.fnv1a32("abd"));
        expect(fallbacks()).toMatchObject([{ reason: "missing", source: "none" }]);
    });

    it("when the binding file is missing", () => {
        inject(() => {
            throw new core.BindingMissingError("gone");
        });
        core.setMode("probe", "rust");
        expect(probe.decodeHex("00ff")).toEqual(new Uint8Array([0, 255]));
        expect(fallbacks()).toMatchObject([{ reason: "missing", source: "test" }]);
    });

    it("when the binding fails to load", () => {
        inject(() => {
            throw new Error("bad ELF header");
        });
        core.setMode("probe", "rust");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(fallbacks()).toMatchObject([{ reason: "load-failed" }]);
        expect(core.status().binding).toBe("load-failed");
    });

    it("when the binding lacks an export (a stale build)", () => {
        const { probePanic: _dropped, ...stale } = jsBinding();
        inject(() => stale as CoreBinding);
        core.setMode("probe", "rust");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(fallbacks()).toMatchObject([{ reason: "load-failed" }]);
    });

    it("when the binding panics, and stops using it", () => {
        const binding = jsBinding({
            probeFnv1a32: vi.fn(() => {
                throw new Error("panicked at src/lib.rs");
            })
        });
        inject(binding);
        core.setMode("probe", "rust");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(binding.probeFnv1a32).toHaveBeenCalledTimes(1);
        expect(fallbacks()).toMatchObject([{ reason: "panic", domain: "probe", op: "fnv1a32" }]);
        expect(core.status().binding).toBe("panic");
    });

    it("treats an error with a code the domain does not throw as a panic", () => {
        inject(jsBinding({ probeDecodeHex: () => Object.assign(new Error("x"), { code: "toString" }) as never }));
        const failing = jsBinding({
            probeDecodeHex: () => {
                throw Object.assign(new Error("x"), { code: "toString" });
            }
        });
        inject(failing);
        core.setMode("probe", "rust");
        expect(probe.decodeHex("00")).toEqual(new Uint8Array([0]));
        expect(fallbacks()).toMatchObject([{ reason: "panic" }]);
    });

    it("when the binding is slower than the domain's timeout, and trips after repeated slowness", () => {
        const slow = vi.fn((text: string) => {
            const until = performance.now() + core.DOMAINS.probe.timeoutMs + 5;
            while (performance.now() < until);
            return twin.fnv1a32(text) + 1;
        });
        inject(jsBinding({ probeFnv1a32: slow }));
        core.setMode("probe", "rust");
        for (let i = 0; i < core.SLOW_CALLS_TO_TRIP; i++) expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(fallbacks().map((r) => r.reason)).toEqual(Array(core.SLOW_CALLS_TO_TRIP).fill("slow"));
        expect(core.status().domains.probe?.tripped).toBe(true);
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(slow).toHaveBeenCalledTimes(core.SLOW_CALLS_TO_TRIP);
    });

    it("while the binding is still loading, without waiting for it", async () => {
        let resolve!: (b: CoreBinding) => void;
        const binding = jsBinding({ probeFnv1a32: vi.fn(() => 99) });
        const load = inject(() => new Promise<CoreBinding>((r) => (resolve = r)));
        core.setMode("probe", "rust");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(core.status().binding).toBe("loading");
        const settled = core.ready();
        resolve(binding);
        expect(await settled).toBe("ready");
        expect(probe.fnv1a32("abc")).toBe(99);
        expect(load).toHaveBeenCalledTimes(1);
        expect(fallbacks()).toEqual([]);
    });

    it("when an asynchronous load fails", async () => {
        inject(() => Promise.reject(new Error("fetch failed")));
        core.setMode("probe", "rust");
        expect(await core.ready()).toBe("load-failed");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(fallbacks()).toMatchObject([{ reason: "load-failed" }]);
    });

    it("ignores a load that finishes after the source was replaced", async () => {
        let resolve!: (b: CoreBinding) => void;
        inject(() => new Promise<CoreBinding>((r) => (resolve = r)));
        core.setMode("probe", "rust");
        const first = core.ready();
        inject(jsBinding({ probeFnv1a32: () => 5 }));
        resolve(jsBinding({ probeFnv1a32: () => 6 }));
        await first;
        expect(probe.fnv1a32("abc")).toBe(5);
    });
});

describe("shadow mode", () => {
    it("serves TypeScript and records nothing when both agree", () => {
        const binding = jsBinding();
        inject(binding);
        core.setMode("probe", "shadow");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(() => probe.decodeHex("zz")).toThrow(new RangeError("Invalid hex string at index 0"));
        expect(binding.probeFnv1a32).toHaveBeenCalledTimes(1);
        expect(binding.probeDecodeHex).toHaveBeenCalledTimes(1);
        expect(core.records()).toEqual([]);
    });

    it("records a planted difference with hashes only, never the input or outputs", () => {
        const secret = "+34 600 000 000";
        inject(jsBinding({ probeFnv1a32: (text) => twin.fnv1a32(text) ^ 1 }));
        core.setMode("probe", "shadow");
        expect(probe.fnv1a32(secret)).toBe(twin.fnv1a32(secret));
        const [entry] = core.records();
        expect(entry).toMatchObject({ kind: "difference", domain: "probe", op: "fnv1a32" });
        if (entry?.kind !== "difference") throw new Error("expected a difference");
        expect(Object.keys(entry).sort()).toEqual(["at", "domain", "inputHash", "kind", "op", "rustHash", "tsHash"]);
        for (const hash of [entry.inputHash, entry.tsHash, entry.rustHash]) expect(hash).toMatch(/^[0-9a-f]{32}$/);
        expect(entry.tsHash).not.toBe(entry.rustHash);
        const text = JSON.stringify(entry);
        for (const leak of [secret, "600", String(twin.fnv1a32(secret))]) expect(text).not.toContain(leak);
    });

    it("records an error on one side only as a difference", () => {
        inject(jsBinding({ probeDecodeHex: () => new Uint8Array([1]) }));
        core.setMode("probe", "shadow");
        expect(() => probe.decodeHex("0")).toThrow(RangeError);
        expect(core.records()).toMatchObject([{ kind: "difference", op: "decodeHex" }]);
    });

    it("hashes an input the same way twice, so repeats can be grouped", () => {
        inject(jsBinding({ probeFnv1a32: () => 0 }));
        core.setMode("probe", "shadow");
        probe.fnv1a32("same");
        probe.fnv1a32("same");
        const [a, b] = core.records() as Extract<core.CoreRecord, { kind: "difference" }>[];
        expect(a?.inputHash).toBe(b?.inputHash);
    });

    it("falls back and records a panic in shadow mode too", () => {
        inject(
            jsBinding({
                probeFnv1a32: () => {
                    throw new RangeError("not a domain code");
                }
            })
        );
        core.setMode("probe", "shadow");
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
        expect(fallbacks()).toMatchObject([{ reason: "panic" }]);
    });
});

describe("records", () => {
    it("go to the recorder, and a throwing recorder never breaks the call", () => {
        const seen: core.CoreRecord[] = [];
        core.setRecorder((r) => seen.push(r));
        core.setBindingSource(null);
        core.setMode("probe", "rust");
        probe.fnv1a32("abc");
        expect(seen).toHaveLength(1);
        core.setRecorder(() => {
            throw new Error("sink down");
        });
        inject(() => {
            throw new Error("x");
        });
        expect(probe.fnv1a32("abc")).toBe(twin.fnv1a32("abc"));
    });

    it("keep a bounded list", () => {
        inject(jsBinding({ probeFnv1a32: () => 0 }));
        core.setMode("probe", "shadow");
        for (let i = 0; i < 250; i++) probe.fnv1a32(`v${i}`);
        expect(core.records()).toHaveLength(200);
    });
});
