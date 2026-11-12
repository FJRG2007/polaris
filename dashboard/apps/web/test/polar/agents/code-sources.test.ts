/**
 * Code's model-first choice: the sources built from the session start's rows,
 * the (source, model) -> engine table, and old saved picks migrated.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import * as cs from "@/lib/polar/agents/code-sources";

const PLAN = "0190c6a0-0000-7000-8000-0000000000a1";
const KEY = "0190c6a0-0000-7000-8000-0000000000a2";

/** The rows `agentOptionsFor` gives for one account read by `clis`. */
function rows(accountId: string, env: string, clis: readonly string[], apiKey: boolean): cs.SourceOption[] {
    return clis.map((cli) => ({
        key: `${cli}:${accountId}`,
        cli,
        readiness: "ready",
        accountId,
        account: "me@example.test",
        mine: true,
        machine: false,
        apiKey,
        env
    }));
}

/** Every catalogue tool that reads `env`, in the catalogue's order. */
const readers = (env: string) =>
    core.AGENT_CLIS.filter((cli) => cli.credentials.some((credential) => credential.env === env)).map(
        (cli) => cli.id
    );

describe("the rule table", () => {
    // Every credential in the catalogue that has a rule, and what runs it.
    const EXPECTED: Record<string, string> = {
        CLAUDE_CODE_OAUTH_TOKEN: "claude",
        ANTHROPIC_API_KEY: "claude",
        CODEX_CHATGPT_AUTH: "codex",
        OPENAI_API_KEY: "codex",
        COPILOT_DEVICE_AUTH: "copilot",
        GH_TOKEN: "copilot",
        GEMINI_GOOGLE_AUTH: "gemini",
        GEMINI_API_KEY: "gemini",
        CURSOR_API_KEY: "cursor",
        AMP_API_KEY: "amp",
        FACTORY_API_KEY: "droid"
    };

    it.each(Object.entries(EXPECTED))("%s runs on %s", (env, engine) => {
        const sources = cs.codeSourcesFor(rows(PLAN, env, readers(env), env.includes("KEY") || env === "GH_TOKEN"));
        expect(sources).toHaveLength(1);
        expect(cs.resolveCodeEngine(sources[0]!, null, { needsSession: true })).toEqual({
            cli: engine,
            accountId: PLAN,
            useMachineLogin: false,
            modelChoice: null
        });
    });

    it("covers every credential the catalogue declares", () => {
        const envs = new Set(core.AGENT_CLIS.flatMap((cli) => cli.credentials.map((entry) => entry.env)));
        for (const env of envs) expect(cs.SOURCE_RULES[env], env).toBeDefined();
        expect(Object.keys(cs.SOURCE_RULES).sort()).toEqual(Object.keys(EXPECTED).sort());
    });

    it("never adds an engine the catalogue does not offer for the account", () => {
        // Only OpenCode reads it here: the rule's first choice is not there.
        const [source] = cs.codeSourcesFor(rows(KEY, "ANTHROPIC_API_KEY", ["opencode"], true));
        expect(source!.engines).toEqual(["opencode"]);
        expect(cs.resolveCodeEngine(source!, null, { needsSession: true })?.cli).toBe("opencode");
    });

    it("prefers the vendor's tool over the others that read the same key", () => {
        const [source] = cs.codeSourcesFor(rows(KEY, "OPENAI_API_KEY", readers("OPENAI_API_KEY"), true));
        expect(source!.engines[0]).toBe("codex");
        expect(source!.engines).toContain("opencode");
        expect(source!.polarProvider).toBe("openai");
    });

    it("hands the model only to an engine that takes one, on its own provider", () => {
        const [claude] = cs.codeSourcesFor(rows(PLAN, "CLAUDE_CODE_OAUTH_TOKEN", ["claude"], false));
        expect(
            cs.resolveCodeEngine(claude!, { provider: "anthropic", model: "claude-opus-4-1" }, { needsSession: true })
                ?.modelChoice
        ).toEqual({ provider: "anthropic", model: "claude-opus-4-1", payer: null });
        expect(
            cs.resolveCodeEngine(claude!, { provider: "openai", model: "gpt-5" }, { needsSession: true })?.modelChoice
        ).toBeNull();
        const [copilot] = cs.codeSourcesFor(rows(PLAN, "COPILOT_DEVICE_AUTH", ["copilot"], false));
        expect(
            cs.resolveCodeEngine(copilot!, { provider: "github", model: "x" }, { needsSession: true })?.modelChoice
        ).toBeNull();
    });
});

describe("Polar's own keys", () => {
    const providers = [
        { provider: "openrouter", name: "OpenRouter", payers: ["own" as const], models: [{ provider: "openrouter", model: "anthropic/claude-opus", name: "Claude Opus" }] },
        { provider: "anthropic", name: "Anthropic", payers: ["own" as const], models: [{ provider: "anthropic", model: "claude-opus", name: "Claude Opus" }] }
    ];

    it("answers in Polar, or on OpenCode when the task needs a session", () => {
        const [openrouter] = cs.polarSourcesFor(providers, []);
        expect(cs.resolveCodeEngine(openrouter!, { provider: "openrouter", model: "anthropic/claude-opus" }, { needsSession: false })?.cli).toBe("polar");
        expect(
            cs.resolveCodeEngine(openrouter!, { provider: "openrouter", model: "anthropic/claude-opus" }, { needsSession: true })
        ).toEqual({
            cli: "opencode",
            accountId: null,
            useMachineLogin: false,
            modelChoice: { provider: "openrouter", model: "anthropic/claude-opus", payer: "own" }
        });
        // A session needs a model of its own.
        expect(cs.resolveCodeEngine(openrouter!, null, { needsSession: true })).toBeNull();
    });

    it("lists an API key once, as the vendor's source", () => {
        const sources = cs.codeSourcesFor(rows(KEY, "ANTHROPIC_API_KEY", readers("ANTHROPIC_API_KEY"), true));
        expect(cs.polarSourcesFor(providers, sources).map((source) => source.key)).toEqual(["polar:openrouter"]);
    });
});

describe("the sources", () => {
    it("are one per account, one per vendor's machine sign-in, and the deployment's ready tools", () => {
        const options: cs.SourceOption[] = [
            ...rows(PLAN, "CLAUDE_CODE_OAUTH_TOKEN", ["claude"], false),
            ...rows(KEY, "ANTHROPIC_API_KEY", readers("ANTHROPIC_API_KEY"), true),
            { key: "claude:machine", cli: "claude", readiness: "unknown", accountId: null, account: null, mine: null, machine: true, apiKey: false, env: null },
            { key: "goose:machine", cli: "goose", readiness: "unknown", accountId: null, account: null, mine: null, machine: true, apiKey: false, env: null },
            { key: "codex", cli: "codex", readiness: "ready", accountId: null, account: null, mine: null, machine: false, apiKey: false, env: null },
            { key: "gemini", cli: "gemini", readiness: "missing", accountId: null, account: null, mine: null, machine: false, apiKey: false, env: null }
        ];
        const sources = cs.codeSourcesFor(options, [{ provider: "anthropic", model: "claude-opus-4-1", name: "Claude Opus 4.1" }]);
        expect(sources.map((source) => source.key)).toEqual([
            `account:${PLAN}`,
            `account:${KEY}`,
            "server:codex",
            "machine:claude"
        ]);
        expect(sources[0]!.models.map((model) => model.model)).toEqual([null, "claude-opus-4-1"]);
        // Nothing a person reads names a tool.
        for (const source of sources) {
            expect(source.label).not.toMatch(/Claude Code|OpenCode|Codex|Goose/);
        }
    });
});

describe("a pick kept before Code was model-first", () => {
    const sources: cs.CodeSource[] = cs.codeSourcesFor([
        ...rows(PLAN, "CLAUDE_CODE_OAUTH_TOKEN", ["claude"], false),
        { key: "claude:machine", cli: "claude", readiness: "unknown", accountId: null, account: null, mine: null, machine: true, apiKey: false, env: null }
    ]);
    const personas = [{ id: "a1", name: "Reviewer", description: "", pick: { source: `account:${PLAN}`, provider: "anthropic", model: "opus" } }];

    it("maps every old shape to a source and model", () => {
        expect(cs.migrateStoredAgent("polar", sources, personas)).toEqual({ pick: cs.AUTOMATIC_PICK, persona: null });
        expect(cs.migrateStoredAgent("tool:claude", sources, personas).pick?.source).toBe(`account:${PLAN}`);
        expect(cs.migrateStoredAgent("claude", sources, personas).pick?.source).toBe(`account:${PLAN}`);
        expect(cs.migrateStoredAgent(`claude:${PLAN}`, sources, personas).pick?.source).toBe(`account:${PLAN}`);
        expect(cs.migrateStoredAgent("claude:machine", sources, personas).pick?.source).toBe("machine:claude");
        expect(cs.migrateStoredAgent("agent:a1", sources, personas)).toEqual({ pick: personas[0]!.pick, persona: "a1" });
    });

    it("leaves the default for what no longer exists", () => {
        expect(cs.migrateStoredAgent("", sources, personas)).toEqual({ pick: null, persona: null });
        expect(cs.migrateStoredAgent("tool:cursor", sources, personas)).toEqual({ pick: null, persona: null });
        expect(cs.migrateStoredAgent("agent:gone", sources, personas)).toEqual({ pick: null, persona: null });
    });

    it("reads back only a pick that validates", () => {
        expect(cs.readStoredPick(JSON.stringify({ source: "account:x", model: "opus" }))).toEqual({
            source: "account:x",
            provider: "",
            model: "opus"
        });
        expect(cs.readStoredPick("{")).toBeNull();
        expect(cs.readStoredPick(JSON.stringify({ source: "" }))).toBeNull();
        expect(cs.codePickSchema.safeParse({ source: "x".repeat(121) }).success).toBe(false);
    });
});
