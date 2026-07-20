import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { mintTerminalTicket } from "@/lib/terminal-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mint a one-shot terminal ticket for an authorized container/target. */
export async function POST(request: Request): Promise<Response> {
    const user = await requirePermission("deploy.manage");
    const body = (await request.json().catch(() => null)) as {
        targetId?: string;
        containerRef?: string;
        mode?: string;
    } | null;
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
