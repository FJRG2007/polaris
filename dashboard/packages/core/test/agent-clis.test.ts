/**
 * The catalogue of command-line agents, and finding them on a machine.
 *
 * The catalogue itself is data, so what is tested is the shape of it: every entry
 * has to be probeable, or it becomes an entry that reads as "not installed" on a
 * machine that has the tool. The detection is tested against a probe that fails
 * the way a real one does - a machine that cannot answer about one tool must
 * still report the rest.
 */

import { describe, expect, it } from "vitest";
import {
    AGENT_CLIS,
    CUSTOM_AGENT_CLI,
    agentCliById,
    customAgentCli,
    detectAgentClis,
    isKnownAgentCli,
    parseAgentCliVersion,
    type AgentCliPresence
} from "../src/agent-clis.js";

describe("the catalogue", () => {
    it("gives every entry something to probe for", () => {
        for (const cli of AGENT_CLIS) {
            expect(cli.binaries.length, cli.id).toBeGreaterThan(0);
            expect(cli.label, cli.id).not.toBe("");
            expect(cli.docs, cli.id).toMatch(/^https:\/\//);
        }
    });

    it("has no two entries claiming the same id or the same binary", () => {
        const ids = AGENT_CLIS.map((cli) => cli.id);
        expect(new Set(ids).size).toBe(ids.length);
        const binaries = AGENT_CLIS.flatMap((cli) => cli.binaries);
        expect(new Set(binaries).size).toBe(binaries.length);
    });

    it("does not answer to the custom id, which has no fixed definition", () => {
        expect(agentCliById(CUSTOM_AGENT_CLI)).toBeNull();
        expect(isKnownAgentCli(CUSTOM_AGENT_CLI)).toBe(true);
        expect(isKnownAgentCli("something-nobody-shipped")).toBe(false);
    });
});

describe("customAgentCli", () => {
    it("probes for the command itself, ignoring the arguments after it", () => {
        expect(customAgentCli("mytool --resume").binaries).toEqual(["mytool"]);
    });

    it("is read from its output, because nothing is known about its configuration", () => {
        expect(customAgentCli("mytool").observe).toBe("output");
        expect(customAgentCli("mytool").home).toBeNull();
    });
});

describe("detectAgentClis", () => {
    const present = (binary: string): AgentCliPresence => ({
        id: "",
        binary,
        path: `/usr/local/bin/${binary}`,
        version: "1.0.0"
    });

    it("reports what a machine has, stamped with the entry it satisfied", async () => {
        const found = await detectAgentClis(async (binary) =>
            binary === "claude" ? present(binary) : null
        );
        expect(found).toEqual([
            { id: "claude", binary: "claude", path: "/usr/local/bin/claude", version: "1.0.0" }
        ]);
    });

    it("keeps scanning when the machine cannot answer about one of them", async () => {
        const found = await detectAgentClis(async (binary) => {
            if (binary === "claude") throw new Error("timed out");
            return binary === "codex" ? present(binary) : null;
        });
        expect(found.map((entry) => entry.id)).toEqual(["codex"]);
    });

    it("takes the first binary an entry offers and stops asking", async () => {
        const asked: string[] = [];
        await detectAgentClis(
            async (binary) => {
                asked.push(binary);
                return present(binary);
            },
            [{ ...AGENT_CLIS[0]!, binaries: ["first", "second"] }]
        );
        expect(asked).toEqual(["first"]);
    });
});

describe("parseAgentCliVersion", () => {
    it("finds the version wherever the tool put it", () => {
        expect(parseAgentCliVersion("2.1.4")).toBe("2.1.4");
        expect(parseAgentCliVersion("mytool version 0.9 (build 3)")).toBe("0.9");
        expect(parseAgentCliVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    });

    it("says nothing rather than putting a banner in a cell headed Version", () => {
        expect(parseAgentCliVersion("a coding agent for your terminal")).toBeNull();
        expect(parseAgentCliVersion("")).toBeNull();
    });
});

describe("every catalogue entry", () => {
    /** Characters a session would carry into a command line or an environment
     *  value; the host daemon refuses a control character outright. */
    const CONTROL = /[\u0000-\u001f\u007f]/;

    it.each(AGENT_CLIS.map((cli) => [cli.id, cli] as const))("%s has a valid shape", (_id, cli) => {
        expect(cli.id).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(cli.label.trim()).not.toBe("");
        expect(cli.binaries.length).toBeGreaterThan(0);
        for (const binary of cli.binaries) expect(binary).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(cli.docs).toMatch(/^https:\/\//);
        if (cli.install !== null) {
            expect(cli.install).not.toMatch(CONTROL);
            expect(cli.install).toMatch(/^(npm install -g |uv tool install |python -m pip |curl -fsSL https:\/\/)/);
            // A downloaded installer is piped into a shell and nothing else.
            if (cli.install.startsWith("curl")) expect(cli.install).toMatch(/\| (CONFIGURE=false )?(ba)?sh$/);
        }
        if (cli.home !== null) expect(cli.home).toMatch(/^\.[A-Za-z0-9._/-]+$/);
        for (const credential of cli.credentials) {
            expect(credential.env).toMatch(/^[A-Z][A-Z0-9_]*$/);
            expect(credential.label.trim()).not.toBe("");
            expect(credential.url).toMatch(/^https:\/\//);
        }
        // Each one is a word on the launch line: no spaces, no shell syntax.
        for (const arg of [...cli.autonomyArgs, ...(cli.acp ?? []), ...(cli.headless ?? [])]) {
            expect(arg).toMatch(/^[A-Za-z0-9=._-]+$/);
        }
        if (cli.acp) expect(cli.acp.length).toBeGreaterThan(0);
        for (const value of Object.values(cli.autonomyEnv)) expect(value).not.toMatch(CONTROL);
    });

    it("names each credential once per tool", () => {
        for (const cli of AGENT_CLIS) {
            const envs = cli.credentials.map((credential) => credential.env);
            expect(new Set(envs).size, cli.id).toBe(envs.length);
        }
    });

    it("knows every agent Agent Orchestrator runs from a terminal", () => {
        // Its adapters under backend/internal/adapters/agent, less the two it
        // runs only through its own runtime (Docker Agent's ACP chat, Unreal
        // Agent built into it) and OpenCode 2, whose binary it never names.
        const orchestrator = [
            "agy", "aider", "amp", "auggie", "autohand", "claude", "cline", "codewhale",
            "codex", "command-code", "continue", "copilot", "crush", "cursor",
            "deepseek-harness", "devin", "droid", "fx", "gemini", "goose", "grok", "hermes",
            "kilocode", "kimchi", "kimi", "kiro", "memcode", "mimo-code", "minimax-code",
            "muse", "omp", "opencode", "openhands", "pi", "prime-agent", "qwen", "stakpak", "vibe"
        ];
        for (const id of orchestrator) expect(agentCliById(id), id).not.toBeNull();
    });
});
