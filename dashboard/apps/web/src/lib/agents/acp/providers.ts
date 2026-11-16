/**
 * Which agents a session can talk to over the Agent Client Protocol, how each
 * one is started for it, and what it can be asked to do once it is up.
 *
 * Every launch line here is the vendor's own documented ACP entry point:
 *
 * - Claude Code has no ACP mode of its own; the ACP project's adapter
 *   (`@agentclientprotocol/claude-agent-acp`, bin `claude-agent-acp`) runs it,
 *   pointed at the session's own `claude` through `CLAUDE_CODE_EXECUTABLE`
 *   (the adapter's README) so the version and the sign-in are the ones the
 *   terminal uses. Pinned: an unpinned `npx` would run whatever was published
 *   a minute ago.
 * - Gemini CLI: `gemini --acp` (geminicli.com/docs/cli/acp-mode).
 * - Qwen Code: `qwen --acp` (qwen-code-docs, integration-zed); 0.16 or later.
 * - Kimi Code: `kimi acp` (kimi-cli reference, kimi-acp).
 * - Cursor: `agent acp` (cursor.com/docs/cli/acp). The catalogue's binary is
 *   `cursor-agent`, the name the Cursor installer keeps beside `agent`, so the
 *   one Polaris already resolves is the one started.
 * - Factory Droid: `droid exec --output-format acp` (docs.factory.com,
 *   integrations/zed and JetBrains).
 * - Grok Build: `grok agent stdio` (docs.x.ai, build/cli/headless-scripting).
 * - OpenCode: `opencode acp` (opencode.ai/docs/acp).
 * - Oh My Pi: `omp acp` (the oh-my-pi README); 15.0.0 or later, the release
 *   that added ACP conformance.
 * - Kimchi: `kimchi --mode acp` (docs.kimchi.dev, coding-acp); 0.0.7 or later.
 * - Hermes Agent: `hermes acp` (hermes-agent.nousresearch.com, features/acp).
 *   It needs Hermes's `acp` extra; without it the agent exits at start.
 * - Command Code: `cmd acp` (commandcode.ai/docs/acp). `command-code` is the
 *   same entry file in the npm package, and the catalogue's first binary.
 * - DeepSeek Harness: `dsh --profile acp` (the harness's apps/cli README).
 * - GitHub Copilot CLI: `copilot --acp`, stdio by default (docs.github.com,
 *   copilot/reference/acp-server).
 * - Antigravity: `agy acp` (antigravity.google/docs/cli/acp).
 *
 * Pi has no ACP mode of its own (only third-party adapters), and OpenCode 2
 * and Docker Agent are not in the catalogue, so none of them has a binding.
 *
 * Nothing here is typed by a person: the launch line is quoted word by word by
 * `acpLaunchCommand`, and a mode is only ever one the agent itself offered.
 */

import type * as core from "@polaris/core";

/** The adapter release Claude Code runs under. Published 2026-10-29, at least
 *  two weeks before it was pinned. */
export const CLAUDE_ACP_ADAPTER = "@agentclientprotocol/claude-agent-acp@0.99.1";

/** How a session's conversation is held: the agent's own terminal (today's
 *  path, and every session's default) or Polaris's chat over ACP. */
export const SESSION_SURFACES = ["terminal", "chat"] as const;
export type SessionSurface = (typeof SESSION_SURFACES)[number];

/** A stored surface read back; anything unknown is the terminal. */
export function readSurface(raw: string | null | undefined): SessionSurface {
    return raw === "chat" ? "chat" : "terminal";
}

export interface AcpBinding {
    /** The catalogue id (`agent-clis.ts`). */
    readonly cli: string;
    /** The launch line, run in the session's checkout. */
    readonly argv: readonly string[];
    /** The oldest release whose ACP mode Polaris drives, where one is known. */
    readonly minVersion: string | null;
    /**
     * The ACP mode ids a Polaris permission mode may become, best first. Only
     * ids the agent offers in its session's `availableModes` are ever sent, so
     * an id here that a release renamed is "not available", never a bad call.
     * Empty where the vendor documents no mode ids.
     */
    readonly modes: Partial<Record<core.SessionPermissionMode, readonly string[]>>;
}

const CLAUDE_LAUNCH = [
    'c="$(command -v claude 2>/dev/null)"',
    'if [ -n "$c" ]; then CLAUDE_CODE_EXECUTABLE="$c"; export CLAUDE_CODE_EXECUTABLE; fi',
    `exec npx -y ${CLAUDE_ACP_ADAPTER}`
].join("; ");

const BINDINGS: readonly AcpBinding[] = [
    {
        cli: "claude",
        argv: ["sh", "-c", CLAUDE_LAUNCH],
        minVersion: null,
        // The adapter's modes are Claude Code's own permission modes, the ones
        // `permissionModeArgs` passes to the terminal.
        modes: {
            ask: ["default"],
            edits: ["acceptEdits"],
            plan: ["plan"],
            full: ["bypassPermissions"]
        }
    },
    { cli: "gemini", argv: ["gemini", "--acp"], minVersion: null, modes: {} },
    { cli: "qwen", argv: ["qwen", "--acp"], minVersion: "0.16.0", modes: {} },
    { cli: "kimi", argv: ["kimi", "acp"], minVersion: null, modes: {} },
    {
        cli: "cursor",
        argv: ["cursor-agent", "acp"],
        minVersion: null,
        // Cursor's documented ACP modes: agent (asks before it acts), plan
        // (read-only). Its `ask` is read-only Q&A, not Polaris's "ask first".
        modes: { ask: ["agent"], plan: ["plan"] }
    },
    { cli: "droid", argv: ["droid", "exec", "--output-format", "acp"], minVersion: null, modes: {} },
    { cli: "grok", argv: ["grok", "agent", "stdio"], minVersion: null, modes: {} },
    { cli: "opencode", argv: ["opencode", "acp"], minVersion: null, modes: {} },
    { cli: "omp", argv: ["omp", "acp"], minVersion: "15.0.0", modes: {} },
    {
        cli: "kimchi",
        argv: ["kimchi", "--mode", "acp"],
        minVersion: "0.0.7",
        // Kimchi's documented ACP modes: default (asks before writes), plan
        // (read-only), auto (asks only before destructive steps), yolo.
        // `auto` is not "accept edits", so edits has no candidate.
        modes: { ask: ["default"], plan: ["plan"], full: ["yolo"] }
    },
    { cli: "hermes", argv: ["hermes", "acp"], minVersion: null, modes: {} },
    {
        cli: "command-code",
        argv: ["command-code", "acp"],
        minVersion: null,
        // Command Code's documented ACP modes: default, auto-accept, plan,
        // dont-ask, bypass.
        modes: { ask: ["default"], edits: ["auto-accept"], plan: ["plan"], full: ["bypass"] }
    },
    { cli: "deepseek-harness", argv: ["dsh", "--profile", "acp"], minVersion: null, modes: {} },
    { cli: "copilot", argv: ["copilot", "--acp"], minVersion: null, modes: {} },
    { cli: "agy", argv: ["agy", "acp"], minVersion: null, modes: {} }
];

/** The binding for a catalogue id, or null for an agent that has none yet. */
export function acpBinding(cli: string): AcpBinding | null {
    return BINDINGS.find((binding) => binding.cli === cli) ?? null;
}

/** The agents whose Chat is their own app-server protocol rather than ACP:
 *  Codex (`codex app-server`, driven by `codex/session-driver.ts`). */
const APP_SERVER_AGENTS: readonly string[] = ["codex"];

/** Whether Chat with this agent goes through its app-server. */
export function usesAppServer(cli: string): boolean {
    return APP_SERVER_AGENTS.includes(cli);
}

/** Whether a session of this agent, placed here, can be switched to Chat.
 *  A session on somebody's computer runs through its runner, not tmux. */
export function chatAvailable(cli: string, place: core.AgentSessionPlace): boolean {
    return place !== "computer" && (acpBinding(cli) !== null || usesAppServer(cli));
}

/** Whether a session talks to its agent over ACP right now. */
export function usesAcp(session: { cli: string; place: core.AgentSessionPlace; surface: SessionSurface }): boolean {
    return session.surface === "chat" && chatAvailable(session.cli, session.place);
}

/** The offered mode id a Polaris mode becomes, or null when the agent offers
 *  none of the candidates. Pure. */
export function acpModeFor(
    binding: AcpBinding,
    mode: core.SessionPermissionMode,
    available: readonly { id: string }[]
): string | null {
    for (const id of binding.modes[mode] ?? []) {
        if (available.some((candidate) => candidate.id === id)) return id;
    }
    return null;
}
