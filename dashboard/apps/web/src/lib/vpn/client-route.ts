/** The one conversation our apps have with the VPN, whichever way they signed in. */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as wg from "@/lib/vpn/wireguard";
import * as service from "@/lib/vpn/wireguard-service";

const connectSchema = z.object({
    nodeId: z.string().uuid(),
    name: wg.deviceNameSchema,
    publicKey: z.string().refine(wg.isWireGuardKey)
});

const STATUS: Partial<Record<service.WireGuardRefusalCode, number>> = {
    noAccess: 403,
    notFound: 404,
    deviceLimit: 409,
    nodeFull: 409,
    nodeNotReady: 503,
    unreachable: 503
};

async function personOf(userId: string): Promise<{ id: string; isAdmin: boolean } | null> {
    return prisma.user.findUnique({ where: { id: userId }, select: { id: true, isAdmin: true } });
}

function refused(error: unknown): Response {
    if (error instanceof service.WireGuardRefusal) {
        return Response.json({ error: error.code }, { status: STATUS[error.code] ?? 400 });
    }
    console.error("polaris: a VPN client call failed:", error);
    return Response.json({ error: "failed" }, { status: 500 });
}

/** The nodes this person may pick. */
export async function listForClient(userId: string): Promise<Response> {
    const person = await personOf(userId);
    if (!person) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
        return Response.json({ nodes: await service.nodesFor(person) });
    } catch (error) {
        return refused(error);
    }
}

export async function connectForClient(userId: string, request: Request): Promise<Response> {
    const person = await personOf(userId);
    if (!person) return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = connectSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "invalid" }, { status: 400 });
    try {
        return Response.json(await service.connectClient(person, body.data));
    } catch (error) {
        return refused(error);
    }
}

const browserSchema = z.object({ nodeId: z.string().uuid() });

export async function browserLoginForClient(userId: string, request: Request): Promise<Response> {
    const person = await personOf(userId);
    if (!person) return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = browserSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "invalid" }, { status: 400 });
    try {
        return Response.json(await service.browserLogin(person, body.data.nodeId));
    } catch (error) {
        return refused(error);
    }
}
