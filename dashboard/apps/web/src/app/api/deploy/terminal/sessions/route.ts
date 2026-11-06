import { z } from "zod";
import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";
import { canOpenHostShell } from "@/lib/terminal-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { terminalSessionCap } from "@/lib/terminal-session-cap";
import {
    SidecarUnavailable,
    changeTerminalSession,
    listTerminalSessions
} from "@/lib/terminal-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The caller's long-lived shells on one server: list them, rename one, close
 * one. Gated exactly like opening a shell there (deploy.manage and the server's
 * owner check), so a user who lost the server loses its sessions with it. Root
 * sessions are left out once the server no longer grants root.
 */

const hostIdSchema = z.string().trim().min(1).max(100);

const changeSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("rename"),
        hostId: hostIdSchema,
        id: z.string().uuid(),
        name: z.string().trim().max(60)
    }),
    z.object({ action: z.literal("close"), hostId: hostIdSchema, id: z.string().uuid() })
]);

async function authorize(hostId: string): Promise<{ userId: string; root: boolean } | Response> {
    const user = await apiPermission("deploy.manage");
    if (user instanceof Response) return user;
    if (!(await canOpenHostShell(user.id, hostId))) {
        return NextResponse.json(
            { error: (await readerWords("api"))("errors.serverNotFound") },
            { status: 404 }
        );
    }
    return { userId: user.id, root: await canOpenHostShell(user.id, hostId, true) };
}

async function unavailable(): Promise<Response> {
    return NextResponse.json(
        { error: (await readerWords("api"))("errors.terminalSessionsUnavailable") },
        { status: 503 }
    );
}

export async function GET(request: Request): Promise<Response> {
    const hostId = hostIdSchema.safeParse(new URL(request.url).searchParams.get("hostId"));
    if (!hostId.success) {
        return NextResponse.json(
            { error: (await readerWords("api"))("errors.terminalTargetRequired") },
            { status: 400 }
        );
    }
    const caller = await authorize(hostId.data);
    if (caller instanceof Response) return caller;
    try {
        const [list, cap] = await Promise.all([
            listTerminalSessions(caller.userId, hostId.data),
            terminalSessionCap()
        ]);
        return NextResponse.json({
            ...list,
            // The setting decides, as it does when the sidecar opens one.
            cap,
            sessions: caller.root ? list.sessions : list.sessions.filter((s) => s.mode === "ssh")
        });
    } catch (error) {
        if (error instanceof SidecarUnavailable) return unavailable();
        throw error;
    }
}

export async function POST(request: Request): Promise<Response> {
    const parsed = changeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json(
            { error: (await readerWords("api"))("errors.terminalSessionInvalid") },
            { status: 400 }
        );
    }
    const caller = await authorize(parsed.data.hostId);
    if (caller instanceof Response) return caller;
    try {
        const ok = await changeTerminalSession(caller.userId, parsed.data);
        if (!ok) {
            return NextResponse.json(
                { error: (await readerWords("api"))("errors.terminalSessionEnded") },
                { status: 404 }
            );
        }
        return NextResponse.json({ ok: true });
    } catch (error) {
        if (error instanceof SidecarUnavailable) return unavailable();
        throw error;
    }
}
