/**
 * Polar Code sessions placed on "This computer": the starter's own PC, through
 * its runner (`docs/runner-protocol.md`).
 *
 * The session is the same row, the same events, messages and permission
 * requests as a container session, so the screens read it unchanged. What
 * differs is only how a command reaches the agent: instead of a command over
 * the daemon or SSH, each one is a protocol frame sent to the runner
 * (`computer-commands.ts`), wherever its socket is.
 *
 * A runner that is not connected refuses with a `SessionRefusal`, whose text
 * is the one sentence the session screen shows. Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { computerFor } from "./computer-service";
import { appBaseUrl } from "@/lib/domain-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { sendToRunner, type RunnerCommand } from "./computer-commands";
import { SessionRefusal, type SessionView } from "@/lib/agents/session-service";

/** The terminal size a session starts at, before anybody opens it. */
const START_COLS = 120;
const START_ROWS = 40;

async function offline(name: string): Promise<SessionRefusal> {
    const t = await readerWords("agents");
    return new SessionRefusal(t("text.computerOffline", { name }));
}

/** The runner a computer session is on. */
async function runnerOf(sessionId: string): Promise<{ runnerId: string; ownerId: string } | null> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { runnerId: true, startedById: true, place: true }
    });
    if (!row || row.place !== "computer" || !row.runnerId || !row.startedById) return null;
    return { runnerId: row.runnerId, ownerId: row.startedById };
}

/** Send a command to a computer session's runner, or refuse in words. */
async function command(sessionId: string, frame: RunnerCommand): Promise<void> {
    const where = await runnerOf(sessionId);
    if (!where) throw new Error("That session is not on a computer.");
    const computer = await computerFor(where.ownerId, where.runnerId);
    if (!computer) throw new SessionRefusal((await readerWords("agents"))("text.computerGone"));
    if (!computer.online || !(await sendToRunner(where.runnerId, frame))) throw await offline(computer.name);
}

/** The `session.start` frame for a session. Pure, so it is asserted. */
export function startFrame(
    session: Pick<
        SessionView,
        "id" | "cli" | "command" | "modelChoice" | "effort" | "permissionMode" | "repoFullName" | "branch" | "baseRef"
    >,
    token: string,
    base: string,
    prompt: string | null
): core.ServerCommand {
    return {
        type: "session.start",
        sessionId: session.id,
        cli: session.cli,
        command: session.command,
        model: session.modelChoice?.model ?? null,
        effort: session.effort,
        permissionMode: session.permissionMode,
        repository: session.repoFullName
            ? {
                  kind: "clone",
                  url: `https://github.com/${session.repoFullName}.git`,
                  fullName: session.repoFullName
              }
            : { kind: "none" },
        branch: session.repoFullName ? session.branch : "",
        baseRef: session.baseRef,
        worktree: Boolean(session.repoFullName),
        prompt: prompt ? prompt.slice(0, core.RUNNER_LIMITS.promptChars) : null,
        report: {
            url: `${base.replace(/\/+$/, "")}/api/agents/sessions/${session.id}/events`,
            token
        },
        cols: START_COLS,
        rows: START_ROWS
    };
}

/** Start a session on its computer. The runner answers `session.started` with
 *  where it runs; the first prompt follows through `promptOnComputer`. */
export async function startOnComputer(session: SessionView, token: string): Promise<void> {
    const where = await runnerOf(session.id);
    if (!where) throw new SessionRefusal((await readerWords("agents"))("text.computerGone"));
    const computer = await computerFor(where.ownerId, where.runnerId);
    if (!computer) throw new SessionRefusal((await readerWords("agents"))("text.computerGone"));
    if (!computer.online) throw await offline(computer.name);
    const frame = startFrame(session, token, await appBaseUrl(), null);
    if (!(await sendToRunner(where.runnerId, frame))) throw await offline(computer.name);
}

export function promptOnComputer(sessionId: string, text: string): Promise<void> {
    return command(sessionId, { type: "prompt", sessionId, text: text.slice(0, core.RUNNER_LIMITS.promptChars) });
}

export function interruptOnComputer(sessionId: string): Promise<void> {
    return command(sessionId, { type: "interrupt", sessionId });
}

/** Ask the runner to end the session. Best effort: the session is already
 *  recorded as stopped, and an offline computer ends it when it next sees it
 *  is gone. */
export async function stopOnComputer(sessionId: string): Promise<void> {
    await command(sessionId, { type: "session.stop", sessionId }).catch(() => undefined);
}

export function settingsOnComputer(
    sessionId: string,
    settings: {
        permissionMode?: core.SessionPermissionMode;
        model?: string;
        effort?: core.AgentEffortLevel;
    }
): Promise<void> {
    return command(sessionId, { type: "session.settings", sessionId, ...settings });
}
