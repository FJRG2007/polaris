"use server";

/**
 * What the Router screen asks for and changes. An administrator's alone: a router
 * decides what every device on a network can reach. Machines are always the
 * caller's own, which `getHostConnection` enforces.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import * as service from "@/lib/router/service";
import { recordAudit } from "@/lib/audit-service";
import { storedNetworks } from "@/lib/vpn/service";
import { getTranslations } from "@/lib/i18n/request";
import { HostNotFoundError } from "@/lib/host-service";

type Result<T = object> = { error: string } | ({ error?: undefined } & T);

const hostSchema = z.object({ hostId: z.string().uuid() });
const applySchema = hostSchema.extend({ plan: z.unknown() });

async function failed(error: unknown): Promise<{ error: string }> {
    const t = await getTranslations("router");
    if (error instanceof service.RouterRefusal) return { error: t(`errors.${error.code}`) };
    if (error instanceof z.ZodError) return { error: t("errors.invalid") };
    if (error instanceof HostNotFoundError) return { error: t("errors.unreachable") };
    console.error("polaris: a router action failed:", error);
    return { error: t("errors.generic") };
}

export interface MachinesAnswer {
    /** Whether there is any server at all. */
    readonly hasMachines: boolean;
    /** The first server Polaris holds root on - what the screen opens on. */
    readonly first: service.RouterMachine | null;
    /** Subnets of the VPN's private networks, offered when adding a network. */
    readonly privateNetworks: { name: string; cidr: string; routerAddress: string }[];
}

export async function listMachinesAction(): Promise<Result<MachinesAnswer>> {
    const user = await requireAdmin();
    try {
        const [start, networks] = await Promise.all([
            service.routerStart(user.id),
            storedNetworks().catch(() => [])
        ]);
        return {
            ...start,
            privateNetworks: networks.map(({ name, cidr, routerAddress }) => ({
                name,
                cidr,
                routerAddress
            }))
        };
    } catch (error) {
        return failed(error);
    }
}

export async function readRouterAction(input: unknown): Promise<Result<service.RouterView>> {
    const user = await requireAdmin();
    try {
        const { hostId } = hostSchema.parse(input);
        return await service.readRouter(hostId, user.id);
    } catch (error) {
        return failed(error);
    }
}

export async function applyRouterAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    try {
        const { hostId, plan } = applySchema.parse(input);
        await service.applyRouter(hostId, user.id, plan);
        await recordAudit({
            actorId: user.id,
            action: "router.apply",
            targetType: "host",
            targetId: hostId
        });
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function removeRouterAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    try {
        const { hostId } = hostSchema.parse(input);
        await service.removeRouter(hostId, user.id);
        await recordAudit({
            actorId: user.id,
            action: "router.remove",
            targetType: "host",
            targetId: hostId
        });
        return {};
    } catch (error) {
        return failed(error);
    }
}
