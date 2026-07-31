import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { canOpenHostShell, mintTerminalTicket } from "@/lib/terminal-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mint a one-shot terminal ticket, either for a container on a deploy target or
 * for a shell on a registered server.
 *
 * The server case is checked here rather than at redeem time: a ticket that
 * cannot be used should never be handed out, and the ownership check is what
 * stops one operator opening a shell on another's machine.
 */
export async function POST(request: Request): Promise<Response> {
    const user = await requirePermission("deploy.manage");
    const body = (await request.json().catch(() => null)) as {
        targetId?: string;
        containerRef?: string;
        hostId?: string;
        mode?: string;
    } | null;

    if (body?.hostId) {
        if (!(await canOpenHostShell(user.id, body.hostId))) {
            return NextResponse.json({ error: "server not found" }, { status: 404 });
        }
        const token = await mintTerminalTicket(user.id, {
            targetId: body.hostId,
            containerRef: "",
            mode: "ssh"
        });
        return NextResponse.json({ token });
    }

    if (!body?.targetId || !body.containerRef) {
        return NextResponse.json({ error: "targetId and containerRef are required" }, { status: 400 });
    }
    const mode = body.mode === "logs" ? "logs" : "terminal";
    const token = await mintTerminalTicket(user.id, {
        targetId: body.targetId,
        containerRef: body.containerRef,
        mode
    });
    return NextResponse.json({ token });
}
