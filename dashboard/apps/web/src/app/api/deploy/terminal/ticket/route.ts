import { NextResponse } from "next/server";
import { accessFor } from "@/lib/container-service";
import { resolveDockerTransport } from "@/lib/docker-service";
import { requireUser, requirePermission, userHasManage } from "@/lib/session";
import { canOpenHostShell, mintTerminalTicket } from "@/lib/terminal-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mint a one-shot terminal ticket for a container on a deploy target, a shell on
 * a registered server, or a container on a Containers connection.
 *
 * Each case is authorized here rather than at redeem time: a ticket that cannot
 * be used should never be handed out, and the ownership check is what stops one
 * operator opening a shell on another's machine. A Containers ticket is gated on
 * system.manage, the same permission that already governs every other action on
 * an engine there, and its connection is resolved once up front so an
 * unreachable one fails before a terminal is opened rather than after.
 */
export async function POST(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
        targetId?: string;
        containerRef?: string;
        hostId?: string;
        connectionId?: string;
        mode?: string;
    } | null;

    if (body?.connectionId) return mintContainersTicket(body.connectionId, body.containerRef ?? "");

    const user = await requirePermission("deploy.manage");

    if (body?.hostId) {
        const asRoot = body.mode === "ssh-root";
        if (!(await canOpenHostShell(user.id, body.hostId, asRoot))) {
            // One answer for "no such server" and "that server never granted root",
            // since the caller has no business telling the two apart.
            return NextResponse.json({ error: "server not found" }, { status: 404 });
        }
        const token = await mintTerminalTicket(user.id, {
            targetId: body.hostId,
            containerRef: "",
            mode: asRoot ? "ssh-root" : "ssh"
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

/**
 * A console on a container listed in the Containers app. The local engine is
 * brokered by the host daemon and keeps the existing `terminal` mode; every
 * other connection is reached over its own Docker transport, which the sidecar
 * cannot build for itself, so it is resolved here to fail fast on a connection
 * that is gone, unpinned, or missing its key.
 */
async function mintContainersTicket(connectionId: string, containerRef: string): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasManage(user, "system.manage"))) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (!containerRef || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerRef)) {
        return NextResponse.json({ error: "a container is required" }, { status: 400 });
    }
    if (accessFor(connectionId) !== "hostd") {
        try {
            await resolveDockerTransport(connectionId, user.id);
        } catch (caught) {
            return NextResponse.json(
                { error: caught instanceof Error ? caught.message : "connection not found" },
                { status: 404 }
            );
        }
    }
    const token = await mintTerminalTicket(user.id, {
        targetId: connectionId,
        containerRef,
        mode: accessFor(connectionId) === "hostd" ? "terminal" : "docker"
    });
    return NextResponse.json({ token });
}
