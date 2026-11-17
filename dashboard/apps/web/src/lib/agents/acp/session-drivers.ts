/**
 * The process's Chat drivers, one per session, on the real session and
 * machine: an ACP driver for an agent with an ACP binding, the app-server
 * driver for Codex (`codex/session-driver.ts`). Held on `globalThis` so a
 * reloaded module in development does not open a second connection beside
 * the first.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { acpBinding, usesAppServer } from "./providers";
import { CODEX_APP_SERVER_ARGV } from "../codex/protocol";
import { touchSession } from "../session-live";
import { sessionDrafts } from "../session-drafts";
import { storeHistoryRows } from "../session-history";
import { sessionPermissionHandler } from "./approvals";
import { shellQuote } from "../session-hooks";
import { runInSession, sessionAcpPipe, startAcpAgent } from "../session-runtime";
import { AcpSessionDriver, type DriverDeps } from "./session-driver";
import { awaitPermission, openPermissionRequest } from "../session-permissions";
import { CodexSessionDriver, type CodexDriverDeps } from "../codex/session-driver";
import { recordSessionConversation, recordSessionEvents } from "../session-service";

const deps: DriverDeps = {
    async session(sessionId) {
        const row = await prisma.agentSession.findUnique({
            where: { id: sessionId },
            select: { cli: true, workdir: true, vendorSessionId: true }
        });
        const binding = row ? acpBinding(row.cli) : null;
        if (!row || !binding || !row.workdir) return null;
        return {
            binding,
            workdir: row.workdir,
            vendorSessionId: core.isVendorSessionId(row.vendorSessionId) ? row.vendorSessionId : null
        };
    },
    async version(sessionId, binary) {
        const result = await runInSession(sessionId, `${shellQuote(binary)} --version 2>/dev/null | head -c 200`);
        return result.code === 0 ? result.output : null;
    },
    start: startAcpAgent,
    pipe: sessionAcpPipe,
    storeRows: storeHistoryRows,
    recordEvents: (sessionId, events) => recordSessionEvents(sessionId, events),
    async recordVendorId(sessionId, vendorSessionId) {
        // An id the Resume button could not type is not kept; the next
        // reconnect then opens a new conversation instead of a wrong one.
        if (!core.isVendorSessionId(vendorSessionId)) return;
        await recordSessionConversation(sessionId, { vendorSessionId, transcriptPath: null });
    },
    permission: (sessionId) => sessionPermissionHandler(sessionId),
    touch: touchSession,
    drafts: sessionDrafts,
    log(message, error) {
        console.error(`[agent-session] ${message}`, ...(error === undefined ? [] : [error]));
    }
};

const codexDeps: CodexDriverDeps = {
    async session(sessionId) {
        const row = await prisma.agentSession.findUnique({
            where: { id: sessionId },
            select: { workdir: true, vendorSessionId: true, permissionMode: true }
        });
        if (!row || !row.workdir) return null;
        return {
            workdir: row.workdir,
            vendorSessionId: core.isVendorSessionId(row.vendorSessionId) ? row.vendorSessionId : null,
            mode: core.sessionPermissionMode(row.permissionMode)
        };
    },
    async help(sessionId) {
        const argv = [...CODEX_APP_SERVER_ARGV, "--help"].map(shellQuote).join(" ");
        const result = await runInSession(sessionId, `${argv} 2>&1 | head -c 4000`);
        return result.code === 0 ? result.output : null;
    },
    start: startAcpAgent,
    pipe: sessionAcpPipe,
    storeRows: storeHistoryRows,
    recordEvents: deps.recordEvents,
    recordVendorId: deps.recordVendorId,
    async ask(sessionId, prompt, signal) {
        const id = await openPermissionRequest(sessionId, { ...prompt, suggestions: null });
        return (await awaitPermission(id, sessionId, undefined, signal)).status;
    },
    touch: touchSession,
    drafts: sessionDrafts,
    log: deps.log
};

/** What a session's Chat asks of its driver, whichever protocol is behind it. */
export interface ChatDriver {
    readonly busy: boolean;
    prompt(text: string): Promise<void>;
    cancel(): Promise<void>;
    setMode(mode: core.SessionPermissionMode): Promise<void>;
    close(): void;
}

const registry = globalThis as unknown as { __polarisAcpDrivers?: Map<string, ChatDriver> };
const drivers = (registry.__polarisAcpDrivers ??= new Map<string, ChatDriver>());

/** The session's driver, made on first use: Codex's app-server for Codex,
 *  ACP for every other agent. */
export function acpDriver(sessionId: string, cli: string): ChatDriver {
    let driver = drivers.get(sessionId);
    if (!driver) {
        driver = usesAppServer(cli) ? new CodexSessionDriver(sessionId, codexDeps) : new AcpSessionDriver(sessionId, deps);
        drivers.set(sessionId, driver);
    }
    return driver;
}

/** Close and forget the session's driver, if it has one. */
export function closeAcpDriver(sessionId: string): void {
    drivers.get(sessionId)?.close();
    drivers.delete(sessionId);
}
