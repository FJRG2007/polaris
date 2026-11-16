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
    }
];

/** The binding for a catalogue id, or null for an agent that has none yet. */
export function acpBinding(cli: string): AcpBinding | null {
    return BINDINGS.find((binding) => binding.cli === cli) ?? null;
}

/** Whether a session of this agent, placed here, can be switched to Chat.
 *  A session on somebody's computer runs through its runner, not tmux. */
export function chatAvailable(cli: string, place: core.AgentSessionPlace): boolean {
    return place !== "computer" && acpBinding(cli) !== null;
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
