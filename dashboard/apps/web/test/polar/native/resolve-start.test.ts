// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const options = vi.hoisted(() => ({ rows: [] as unknown[] }));
const preferences = vi.hoisted(() => ({ sessionEngine: null as string | null, fail: false }));

vi.mock("@/lib/agents/agent-readiness", () => ({ agentOptionsFor: async () => options.rows }));
vi.mock("@/lib/polar/preferences", () => ({
    polarPreferences: async () => {
        if (preferences.fail) throw new Error("column missing");
        return { sessionEngine: preferences.sessionEngine };
    }
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));

import { resolvedStart } from "@/lib/polar/agents/resolve-start";
import { NATIVE_ENGINE } from "@/lib/polar/native/engine-choice";

const USER = { id: "u1" } as Parameters<typeof resolvedStart>[0];

/** One Anthropic API key linked to both Claude Code and OpenCode. */
const anthropicKey = (cli: string) => ({
    key: `${cli}:a1`,
    cli,
    readiness: "ready",
    accountId: "a1",
    account: "key",
    mine: true,
    machine: false,
    apiKey: true,
    env: "ANTHROPIC_API_KEY"
});

const pick = { source: "account:a1", provider: "anthropic", model: null };

describe("resolvedStart engine choice", () => {
    beforeEach(() => {
        options.rows = [anthropicKey("claude"), anthropicKey("opencode")];
        preferences.sessionEngine = null;
        preferences.fail = false;
    });

    it("resolves exactly as before with no setting and no override", async () => {
        const result = await resolvedStart(USER, { pick, title: "t" });
        expect(result).toEqual({
            input: { title: "t", cli: "claude", accountId: "a1", useMachineLogin: false, modelChoice: null }
        });
    });

    it("never passes the override through to the start input", async () => {
        const result = await resolvedStart(USER, { pick, engine: "claude" });
        expect("input" in result && "engine" in result.input).toBe(false);
    });

    it("uses the person's setting where it serves the pick", async () => {
        preferences.sessionEngine = "opencode";
        const result = await resolvedStart(USER, { pick });
        expect("input" in result && result.input.cli).toBe("opencode");
        expect("input" in result && result.input.accountId).toBe("a1");
    });

    it("takes the session's override over the setting", async () => {
        preferences.sessionEngine = "opencode";
        const result = await resolvedStart(USER, { pick, engine: "claude" });
        expect("input" in result && result.input.cli).toBe("claude");
    });

    it("keeps today's engine for an explicit native pick while the runtime is not ready", async () => {
        preferences.sessionEngine = NATIVE_ENGINE;
        const fromSetting = await resolvedStart(USER, { pick });
        const fromOverride = await resolvedStart(USER, { pick, engine: NATIVE_ENGINE });
        expect("input" in fromSetting && fromSetting.input.cli).toBe("claude");
        expect("input" in fromOverride && fromOverride.input.cli).toBe("claude");
    });

    it("ignores an engine that cannot serve the pick, or is not an engine id", async () => {
        const unserved = await resolvedStart(USER, { pick, engine: "codex" });
        const garbage = await resolvedStart(USER, { pick, engine: "../bin/sh" });
        expect("input" in unserved && unserved.input.cli).toBe("claude");
        expect("input" in garbage && garbage.input.cli).toBe("claude");
    });

    it("starts on Automatic when the setting cannot be read", async () => {
        preferences.fail = true;
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const result = await resolvedStart(USER, { pick });
        expect("input" in result && result.input.cli).toBe("claude");
        spy.mockRestore();
    });

    it("still refuses a pick that is not the person's", async () => {
        const result = await resolvedStart(USER, { pick: { ...pick, source: "account:other" } });
        expect(result).toEqual({ error: "code.noSource" });
    });
});
