/**
 * A tool's own model list: the script run on the session's machine, its framed
 * and bounded answer, each tool's parser, and the merge into Code's sources.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import * as nm from "@/lib/agents/native-models";
import { execFileSync } from "node:child_process";
import { codeSourcesFor } from "@/lib/polar/agents/code-sources";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const NONCE = "0123456789abcdef0123456789abcdef";
const frame = (sections: Record<string, string>) =>
    `${Object.entries(sections)
        .map(([name, body]) => `\n@@${NONCE} ${name}@@\n${body}`)
        .join("")}\n@@${NONCE} end@@\n`;

describe("the script run on the machine", () => {
    it("exists for every tool with a reader and none other", () => {
        for (const cli of nm.NATIVE_MODEL_CLIS) expect(nm.nativeModelsScript(cli, NONCE)).toContain(`@@${NONCE} end@@`);
        expect(nm.nativeModelsScript("claude", NONCE)).toBeNull();
        expect(nm.readsNativeModels("aider")).toBe(false);
    });

    it("refuses a nonce that is not hex, so nothing foreign reaches the shell", () => {
        expect(nm.nativeModelsScript("opencode", "x'; rm -rf / #")).toBeNull();
        expect(nm.splitSections(frame({ list: "a/b" }), "nope").size).toBe(0);
    });

    it("asks each tool the documented way and bounds every section", () => {
        const opencode = nm.nativeModelsScript("opencode", NONCE)!;
        expect(opencode).toContain("for c in 'opencode'");
        expect(opencode).toContain(`"$B" 'models'`);
        expect(opencode).toContain('"${XDG_CACHE_HOME:-$HOME/.cache}"/opencode/models.json');
        expect(nm.nativeModelsScript("kilocode", NONCE)).toContain("/kilo/models.json");
        expect(nm.nativeModelsScript("mimo-code", NONCE)).toContain("/mimocode/models.json");
        expect(nm.nativeModelsScript("pi", NONCE)).toContain("'--list-models'");
        expect(nm.nativeModelsScript("kimchi", NONCE)).toContain("$HOME/.config/kimchi/harness");
        const omp = nm.nativeModelsScript("omp", NONCE)!;
        expect(omp).toContain("sqlite3 -readonly");
        expect(omp).toContain("SELECT models FROM model_cache");
        const codex = nm.nativeModelsScript("codex", NONCE)!;
        expect(codex).toContain("app-server");
        expect(codex).toContain('"method":"model/list"');
        for (const cli of nm.NATIVE_MODEL_CLIS) {
            const script = nm.nativeModelsScript(cli, NONCE)!;
            expect(script).toMatch(/head -c \d+/);
        }
    });

    it.skipIf(process.platform === "win32")("runs under sh against a fake tool and its cache", () => {
        const root = mkdtempSync(join(tmpdir(), "native-models-"));
        try {
            mkdirSync(join(root, "bin"));
            mkdirSync(join(root, ".cache", "opencode"), { recursive: true });
            writeFileSync(join(root, "bin", "opencode"), "#!/bin/sh\necho anthropic/claude-sonnet-4-6\necho openai/gpt-5.5\n");
            chmodSync(join(root, "bin", "opencode"), 0o755);
            writeFileSync(
                join(root, ".cache", "opencode", "models.json"),
                JSON.stringify({ groq: { models: { "llama-4": { id: "llama-4", name: "Llama 4" } } } })
            );
            const output = execFileSync("sh", ["-c", nm.nativeModelsScript("opencode", NONCE)!], {
                env: { PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: root },
                encoding: "utf8"
            });
            expect(nm.parseNativeModels("opencode", output, NONCE).map((model) => model.id)).toEqual([
                "anthropic/claude-sonnet-4-6",
                "openai/gpt-5.5",
                "groq/llama-4"
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("each tool's answer", () => {
    it("reads OpenCode's lines and cache, the command first", () => {
        const output = frame({
            list: "\x1b[1manthropic/claude-sonnet-4-6\x1b[0m\nnot a model line\nopenai/gpt-5.5\n",
            cache: JSON.stringify({
                anthropic: { models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", apiKey: "sk-secret" } } },
                openrouter: { models: [{ id: "meta/llama", name: "Llama" }] }
            })
        });
        const models = nm.parseNativeModels("opencode", output, NONCE);
        expect(models).toEqual([
            { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
            { id: "openai/gpt-5.5", name: "gpt-5.5", provider: "openai" },
            { id: "openrouter/meta/llama", name: "Llama", provider: "openrouter" }
        ]);
        expect(JSON.stringify(models)).not.toContain("sk-secret");
    });

    it("reads MiMo's inline details", () => {
        expect(nm.parseMimoModels("mimo/mimo-auto — window 1M, compacts at 900K\nxiaomi/mimo-v2.5 — window 1.05M\n")).toEqual([
            { id: "mimo/mimo-auto", name: "mimo-auto", provider: "mimo" },
            { id: "xiaomi/mimo-v2.5", name: "mimo-v2.5", provider: "xiaomi" }
        ]);
    });

    it("reads Pi's table, skips Kimchi's notices, and adds declared providers", () => {
        const output = frame({
            list: `[model-roles] Warning: explorer model "kimchi-dev/x" is not available.
provider    model                context  max-out  thinking  images
kimchi-dev  deepseek-v4.1-flash  1.0M     512K     yes       yes
`,
            custom: JSON.stringify({ providers: { local: { apiKey: "secret", models: [{ id: "qwen3" }] } } })
        });
        expect(nm.parseNativeModels("kimchi", output, NONCE).map((model) => model.id)).toEqual([
            "kimchi-dev/deepseek-v4.1-flash",
            "local/qwen3"
        ]);
    });

    it("reads Oh My Pi's JSON and its database rows, trusting the record's provider", () => {
        const output = frame({
            list: JSON.stringify({ providers: [{ id: "anthropic", models: [{ id: "claude-opus-4-1", name: "Opus" }] }] }),
            db: '[{"id":"org/model","provider":"router","name":"Model"}]\nnot json\n'
        });
        expect(nm.parseNativeModels("omp", output, NONCE)).toEqual([
            { id: "claude-opus-4-1", name: "Opus", provider: "anthropic" },
            { id: "router/org/model", name: "Model", provider: "router" }
        ]);
    });

    it("reads Codex's model/list among its other lines, default first, hidden left out", () => {
        const list = [
            JSON.stringify({ id: 1, result: { userAgent: "x" } }),
            JSON.stringify({ method: "some/notification", params: {} }),
            JSON.stringify({
                id: 2,
                result: {
                    data: [
                        { id: "gpt-5.4", displayName: "GPT-5.4" },
                        { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
                        { id: "internal", hidden: true }
                    ],
                    nextCursor: null
                }
            })
        ].join("\n");
        expect(nm.parseNativeModels("codex", frame({ list }), NONCE)).toEqual([
            { id: "gpt-5.5", name: "GPT-5.5", provider: "" },
            { id: "gpt-5.4", name: "GPT-5.4", provider: "" }
        ]);
    });

    it("reads nothing from a cut or empty answer instead of guessing", () => {
        expect(nm.parseNativeModels("opencode", `\n@@${NONCE} cache@@\n{"anthropic":{"models":{`, NONCE)).toEqual([]);
        expect(nm.parseNativeModels("codex", "", NONCE)).toEqual([]);
    });

    it("drops ids a command line would refuse, and stays bounded", () => {
        const many = Array.from({ length: nm.MAX_NATIVE_MODELS + 50 }, (_, index) => `p/m-${index}`).join("\n");
        expect(nm.parseNativeModels("opencode", frame({ list: `${many}\n-rf\n` }), NONCE)).toHaveLength(nm.MAX_NATIVE_MODELS);
        expect(nm.normalize([{ id: "bad id; rm", name: "", provider: "" }])).toEqual([]);
    });

    it("reads a stored list back, and a broken one as nothing", () => {
        expect(nm.readStoredModels('[{"id":"a/b","name":"B","provider":"a"}]')).toHaveLength(1);
        expect(nm.readStoredModels("{oops")).toEqual([]);
        expect(nm.readStoredModels('[{"id":""}]')).toEqual([]);
    });
});

describe("merged into Code's sources", () => {
    const options = [
        { key: "codex:machine", cli: "codex", readiness: "unknown" as const, accountId: null, account: null, mine: null, machine: true, apiKey: false }
    ];
    const catalogue = [
        { provider: "openai", model: "gpt-5.4", name: "GPT-5.4" },
        { provider: "openai", model: "gpt-4.1", name: "GPT-4.1" }
    ];

    it("lists the tool's own models first, then the index's others, once each", () => {
        const native = new Map([["codex", [{ id: "gpt-5.5", name: "GPT-5.5", provider: "" }, { id: "gpt-5.4", name: "gpt-5.4", provider: "" }]]]);
        const [source] = codeSourcesFor(options, catalogue, new Map(), native);
        expect(source!.models.map((model) => [model.model, model.name])).toEqual([
            [null, ""],
            ["gpt-5.5", "GPT-5.5"],
            ["gpt-5.4", "GPT-5.4"],
            ["gpt-4.1", "GPT-4.1"]
        ]);
    });

    it("keeps the index alone when the tool never reported", () => {
        const [source] = codeSourcesFor(options, catalogue);
        expect(source!.models.map((model) => model.model)).toEqual([null, "gpt-5.4", "gpt-4.1"]);
    });
});
