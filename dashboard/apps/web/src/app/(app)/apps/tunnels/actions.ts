"use server";

/**
 * Tunnels server actions. Every one re-checks the permission and parses its input:
 * a tunnel starts containers on two servers and puts a hostname on an edge, so
 * nothing the form last saw is trusted.
 *
 * Only a `TunnelRefusal` reaches the screen in its own words; anything else - an
 * SSH failure, a daemon's answer - is logged here and replaced with a generic
 * sentence, because those messages name internals nobody asked to publish.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { normalizeHostname } from "@/lib/deploy/wireguard/tunnel-hostname";
import { getTranslations } from "@/lib/i18n/request";
import * as tunnels from "@/lib/deploy/wireguard/tunnel-service";

const TUNNELS_PATH = "/apps/tunnels";

const idSchema = z.object({ id: z.string().uuid() });
const idsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });
const pausedSchema = z.object({ id: z.string().uuid(), paused: z.boolean() });
const createSchema = z.object({
    publicServerId: z.string().uuid(),
    serviceId: z.string().uuid(),
    hostname: z.string().max(253).transform(normalizeHostname)
});

type Reply = { error?: string };

/** What went wrong, in the reader's words. */
async function failure(caught: unknown, where: string): Promise<string> {
    const t = await getTranslations("tunnels");
    if (caught instanceof tunnels.TunnelRefusal) return t(`refusals.${caught.code}`, caught.params);
    console.error(`[tunnels] ${where} failed`, caught);
    return t("refusals.generic");
}

export async function createTunnelAction(input: unknown): Promise<Reply & { id?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) {
        const hostnameIssue = parsed.error.issues.some((issue) => issue.path[0] === "hostname");
        return {
            error: (await getTranslations("tunnels"))(
                hostnameIssue ? "refusals.hostname" : "refusals.generic"
            )
        };
    }
    try {
        const created = await tunnels.createTunnel(user.id, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "deploy.tunnel.create",
            targetType: "wireguardTunnel",
            targetId: created.id,
            metadata: { hostname: parsed.data.hostname }
        });
        revalidatePath(TUNNELS_PATH);
        return { id: created.id };
    } catch (caught) {
        return { error: await failure(caught, "create") };
    }
}

export async function setTunnelPausedAction(input: unknown): Promise<Reply> {
    const user = await requirePermission("deploy.manage");
    const parsed = pausedSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("tunnels"))("refusals.notFound") };
    try {
        await tunnels.setTunnelPaused(user.id, parsed.data.id, parsed.data.paused);
        await recordAudit({
            actorId: user.id,
            action: parsed.data.paused ? "deploy.tunnel.pause" : "deploy.tunnel.resume",
            targetType: "wireguardTunnel",
            targetId: parsed.data.id
        });
    } catch (caught) {
        return { error: await failure(caught, "pause") };
    }
    revalidatePath(TUNNELS_PATH);
    return {};
}

export async function removeTunnelAction(input: unknown): Promise<Reply> {
    const user = await requirePermission("deploy.manage");
    const parsed = idSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("tunnels"))("refusals.notFound") };
    try {
        await tunnels.removeTunnel(user.id, parsed.data.id);
        await recordAudit({
            actorId: user.id,
            action: "deploy.tunnel.remove",
            targetType: "wireguardTunnel",
            targetId: parsed.data.id
        });
    } catch (caught) {
        return { error: await failure(caught, "remove") };
    }
    revalidatePath(TUNNELS_PATH);
    return {};
}

/** The live state of the tunnels on screen, each read from whichever end answers. */
export async function tunnelStatusesAction(
    input: unknown
): Promise<{ statuses?: Record<string, tunnels.TunnelStatus>; error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = idsSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("tunnels"))("refusals.notFound") };
    try {
        return { statuses: await tunnels.readTunnelStatuses(user.id, parsed.data.ids) };
    } catch (caught) {
        return { error: await failure(caught, "status") };
    }
}
