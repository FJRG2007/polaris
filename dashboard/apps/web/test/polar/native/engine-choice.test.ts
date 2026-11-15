// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
    AUTO_ENGINE,
    NATIVE_ENGINE,
    NATIVE_RUNTIME_READY,
    NATIVE_SESSIONS_ENABLED,
    automaticEngine,
    engineFor,
    engineOptions,
    nativeCanServe,
    sessionEngineSchema
} from "@/lib/polar/native/engine-choice";

const KNOWN = ["claude", "opencode", "codex", "gemini"];

const apiKey = { key: "account:a1", kind: "apiKey", engines: ["claude", "opencode"] } as const;
const polar = { key: "polar:openai", kind: "polar", engines: ["polar", "opencode"] } as const;
const plan = { key: "account:p1", kind: "subscription", engines: ["claude"] } as const;
const machine = { key: "machine:claude", kind: "machine", engines: ["claude"] } as const;
const server = { key: "server:claude", kind: "server", engines: ["claude"] } as const;

const optionOf = (options: ReturnType<typeof engineOptions>, id: string) => options.find((option) => option.id === id);

describe("engine choice switches", () => {
    it("ships with both switches off", () => {
        expect(NATIVE_SESSIONS_ENABLED).toBe(false);
        expect(NATIVE_RUNTIME_READY).toBe(false);
    });
});

describe("nativeCanServe", () => {
    it("serves API keys and Polar providers only", () => {
        expect(nativeCanServe(apiKey)).toBe(true);
        expect(nativeCanServe(polar)).toBe(true);
        expect(nativeCanServe(plan)).toBe(false);
        expect(nativeCanServe(machine)).toBe(false);
        expect(nativeCanServe(server)).toBe(false);
    });
});

describe("engineOptions", () => {
    it("lists native first, disabled until the runtime is ready", () => {
        const options = engineOptions(apiKey, KNOWN, null);
        expect(options[0]).toEqual({ id: NATIVE_ENGINE, disabled: "notReady" });
        expect(engineOptions(apiKey, KNOWN, null, true)[0]).toEqual({ id: NATIVE_ENGINE, disabled: null });
    });

    it("says native cannot serve a subscription, even when ready", () => {
        expect(engineOptions(plan, KNOWN, null, true)[0]).toEqual({ id: NATIVE_ENGINE, disabled: "cannotServe" });
    });

    it("keeps the source's own engines first, then the rest of the catalogue, without Polar's chat runtime", () => {
        const ids = engineOptions(polar, KNOWN, null).map((option) => option.id);
        expect(ids).toEqual([NATIVE_ENGINE, "opencode", "claude", "codex", "gemini"]);
        expect(ids).not.toContain("polar");
    });

    it("disables CLIs that cannot take the pick, and ones missing from the placement", () => {
        const options = engineOptions(apiKey, KNOWN, new Set(["claude"]));
        expect(optionOf(options, "claude")?.disabled).toBeNull();
        expect(optionOf(options, "opencode")?.disabled).toBe("notInstalled");
        expect(optionOf(options, "codex")?.disabled).toBe("cannotServe");
    });

    it("disables nothing for being absent when the placement's tools are unknown", () => {
        const options = engineOptions(apiKey, KNOWN, null);
        expect(optionOf(options, "opencode")?.disabled).toBeNull();
    });

    it("lists each engine once", () => {
        const ids = engineOptions(apiKey, [...KNOWN, "claude"], null).map((option) => option.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe("automaticEngine", () => {
    it("is today's engine while the switch is off", () => {
        for (const source of [apiKey, polar, plan, machine, server]) {
            expect(automaticEngine(source, "opencode")).toBe("opencode");
            expect(automaticEngine(source, "opencode", false, true)).toBe("opencode");
        }
    });

    it("stays on today's engine when switched on but the runtime is not ready", () => {
        expect(automaticEngine(apiKey, "opencode", true, false)).toBe("opencode");
    });

    it("sends API keys and Polar providers to native once both are on, never subscriptions", () => {
        expect(automaticEngine(apiKey, "claude", true, true)).toBe(NATIVE_ENGINE);
        expect(automaticEngine(polar, "opencode", true, true)).toBe(NATIVE_ENGINE);
        expect(automaticEngine(plan, "claude", true, true)).toBe("claude");
        expect(automaticEngine(machine, "claude", true, true)).toBe("claude");
        expect(automaticEngine(server, "claude", true, true)).toBe("claude");
    });
});

describe("engineFor", () => {
    const base = { source: apiKey, fallback: "claude", known: KNOWN, installed: null } as const;

    it("is exactly the fallback with no setting and no override", () => {
        expect(engineFor({ ...base, setting: null, override: null })).toBe("claude");
        expect(engineFor({ ...base, setting: AUTO_ENGINE, override: AUTO_ENGINE })).toBe("claude");
    });

    it("ignores an explicit native pick while the runtime is not ready", () => {
        expect(engineFor({ ...base, setting: NATIVE_ENGINE, override: null })).toBe("claude");
        expect(engineFor({ ...base, setting: null, override: NATIVE_ENGINE })).toBe("claude");
    });

    it("honours an explicit native pick once the runtime is ready", () => {
        expect(engineFor({ ...base, setting: NATIVE_ENGINE, override: null, nativeReady: true })).toBe(NATIVE_ENGINE);
    });

    it("takes the override over the setting, and the setting over Automatic", () => {
        expect(engineFor({ ...base, setting: "opencode", override: null })).toBe("opencode");
        expect(engineFor({ ...base, setting: "opencode", override: "claude" })).toBe("claude");
        expect(engineFor({ ...base, setting: "opencode", override: AUTO_ENGINE })).toBe("opencode");
    });

    it("falls back to Automatic when the stored choice no longer fits the pick", () => {
        expect(engineFor({ ...base, setting: "codex", override: null })).toBe("claude");
        expect(engineFor({ ...base, setting: "unknown-cli", override: "gemini" })).toBe("claude");
        expect(engineFor({ ...base, installed: new Set(["claude"]), setting: "opencode", override: null })).toBe("claude");
    });

    it("never lets a subscription leave its vendor's tool", () => {
        expect(
            engineFor({ source: plan, fallback: "claude", known: KNOWN, installed: null, setting: "opencode", override: NATIVE_ENGINE, enabled: true, nativeReady: true })
        ).toBe("claude");
    });
});

describe("sessionEngineSchema", () => {
    it("accepts engine ids and refuses anything else", () => {
        expect(sessionEngineSchema.parse(" opencode ")).toBe("opencode");
        expect(sessionEngineSchema.safeParse(NATIVE_ENGINE).success).toBe(true);
        expect(sessionEngineSchema.safeParse("").success).toBe(false);
        expect(sessionEngineSchema.safeParse("Claude").success).toBe(false);
        expect(sessionEngineSchema.safeParse("a/b").success).toBe(false);
        expect(sessionEngineSchema.safeParse("x".repeat(41)).success).toBe(false);
    });
});
