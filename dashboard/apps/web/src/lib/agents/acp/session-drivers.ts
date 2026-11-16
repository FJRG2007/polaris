/**
 * The process's ACP drivers, one per session, on the real session and machine.
 * Held on `globalThis` so a reloaded module in development does not open a
 * second connection beside the first.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { acpBinding } from "./providers";
import { touchSession } from "../session-live";
import { storeHistoryRows } from "../session-history";
import { sessionPermissionHandler } from "./approvals";
import { shellQuote } from "../session-hooks";
import { runInSession, sessionAcpPipe, startAcpAgent } from "../session-runtime";
import { AcpSessionDriver, type DriverDeps } from "./session-driver";
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
    log(message, error) {
        console.error(`[agent-session] ${message}`, ...(error === undefined ? [] : [error]));
    }
};

const registry = globalThis as unknown as { __polarisAcpDrivers?: Map<string, AcpSessionDriver> };
const drivers = (registry.__polarisAcpDrivers ??= new Map<string, AcpSessionDriver>());

/** The session's driver, made on first use. */
export function acpDriver(sessionId: string): AcpSessionDriver {
    let driver = drivers.get(sessionId);
    if (!driver) {
        driver = new AcpSessionDriver(sessionId, deps);
        drivers.set(sessionId, driver);
    }
    return driver;
}

/** Close and forget the session's driver, if it has one. */
export function closeAcpDriver(sessionId: string): void {
    drivers.get(sessionId)?.close();
    drivers.delete(sessionId);
}
