import { prisma } from "@polaris/db";
import { NextResponse } from "next/server";
import { accessFor } from "@/lib/container-service";
import { currentReleaseRef } from "@/lib/deploy/releases";
import { resolveDockerTransport } from "@/lib/docker-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
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
        applicationId?: string;
        sessionId?: string;
        hostId?: string;
        connectionId?: string;
        containerRef?: string;
        mode?: string;
    } | null;

    if (body?.connectionId) return mintContainersTicket(body.connectionId, body.containerRef ?? "");

    // A session terminal is the Agents app's, not Deploy's, so it is authorised
    // before the deploy permission below is asked for at all.
    if (body?.sessionId) return mintSessionTicket(body.sessionId);

    const user = await requirePermission("deploy.manage");

    if (body?.applicationId) {
        return mintServiceTicket(user.id, body.applicationId, body.mode === "logs" ? "logs" : "terminal");
    }

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

    return NextResponse.json({ error: "applicationId, hostId or connectionId is required" }, { status: 400 });
}

/**
 * A terminal on a live coding-agent session.
 *
 * Attaching to somebody's agent is watching them work and being able to type at
 * it, so it wants the permission that manages agents rather than the one that
 * reads them. The container is resolved here from the session row: the caller
 * names a session and never a container, which is what stops a ticket being
 * asked for one they have no standing on.
 *
 * Only a `local` session has one. A session on an enrolled server lives in a tmux
 * on that machine, and the way to that terminal is the server's own shell -
 * offering a second door to it here would be a second thing to get wrong.
 */
async function mintSessionTicket(sessionId: string): Promise<Response> {
    const user = await requirePermission("agents.manage");
    const session = await prisma.agentSession.findFirst({
        where: { id: sessionId, repo: { ownerId: user.id } },
        select: { containerId: true, place: true, state: true }
    });
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
    if (session.place !== "local" || !session.containerId) {
        return NextResponse.json(
            { error: "That session runs on one of your servers. Open a shell on the server instead." },
            { status: 409 }
        );
    }
    if (session.state === "stopped" || session.state === "failed") {
        return NextResponse.json({ error: "That session has ended." }, { status: 409 });
    }
    const token = await mintTerminalTicket(user.id, {
        targetId: sessionId,
        containerRef: session.containerId,
        mode: "agent"
    });
    return NextResponse.json({ token });
}

/**
 * A console on one deployed service.
 *
 * The caller names the service and nothing else. Which container that is - a
 * service keeping its releases side by side runs each under its own name - is
 * resolved here from the service's current release, so a ticket can never be
 * asked for a container the caller has no standing on: the target and the
 * container both come from the row the access check just passed.
 *
 * `console.use` rather than the ability to deploy, because a shell inside the
 * container reaches whatever the container can, its variables included - which
 * is a decision worth making on its own.
 */
async function mintServiceTicket(
    userId: string,
    applicationId: string,
    mode: "terminal" | "logs"
): Promise<Response> {
    try {
        await requireApplicationAccess(applicationId, userId, mode === "logs" ? "logs.read" : "console.use");
    } catch {
        return NextResponse.json({ error: "service not found" }, { status: 404 });
    }
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: {
            id: true,
            slug: true,
            targetId: true,
            currentDeploymentId: true,
            environment: { select: { project: { select: { slug: true } } } }
        }
    });
    if (!app) return NextResponse.json({ error: "service not found" }, { status: 404 });
    const serving = await currentReleaseRef(app);
    const token = await mintTerminalTicket(userId, {
        targetId: app.targetId,
        containerRef: serving.name,
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
