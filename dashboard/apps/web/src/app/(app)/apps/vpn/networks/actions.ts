"use server";

/**
 * What the Private networks screen asks for and changes. Anybody signed in reads
 * the networks shared with them; creating, changing and removing one is an
 * administrator's. Input is validated here, and a refusal comes back as a sentence
 * in the reader's language.
 */

import { z } from "zod";
import * as vpn from "@/lib/vpn/service";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import * as service from "@/lib/vpn/network-service";
import { requireAdmin, requireUser } from "@/lib/session";
import { networkChangeSchema, networkInputSchema } from "@/lib/vpn/networks";

type Result<T = object> = { error: string } | ({ error?: undefined } & T);

async function failed(error: unknown): Promise<{ error: string }> {
    const t = await getTranslations("vpn");
    if (error instanceof vpn.VpnRefusal) return { error: t(`errors.${error.code}`) };
    if (error instanceof z.ZodError) return { error: t("errors.invalid") };
    console.error("polaris: a private network action failed:", error);
    return { error: t("errors.generic") };
}

const idSchema = z.object({ id: z.string().uuid() });

export interface NetworksAnswer {
    readonly networks: service.NetworkView[];
    /** Where a gateway can run; empty for anybody but an administrator. */
    readonly servers: service.NetworkServer[];
}

/** The networks the reader may see, asked after the first paint. */
export async function listNetworksAction(): Promise<Result<NetworksAnswer>> {
    const user = await requireUser();
    try {
        const [networks, servers] = await Promise.all([
            service.listNetworks({ id: user.id, isAdmin: user.isAdmin }),
            user.isAdmin ? service.networkServers(user.id) : Promise.resolve([])
        ]);
        return { networks, servers };
    } catch (error) {
        return failed(error);
    }
}

export async function createNetworkAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    try {
        const network = await service.createNetwork(user, networkInputSchema.parse(input));
        await recordAudit({
            actorId: user.id,
            action: "vpn.network.create",
            targetType: "vpnNetwork",
            targetId: network.id
        });
        revalidatePath("/apps/vpn/networks");
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function updateNetworkAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    try {
        const change = networkChangeSchema.parse(input);
        await service.updateNetwork(change);
        await recordAudit({
            actorId: user.id,
            action: "vpn.network.update",
            targetType: "vpnNetwork",
            targetId: change.id
        });
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function retryGatewayAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    try {
        await service.retryGateway(user, idSchema.parse(input).id);
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function removeNetworkAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    try {
        const { id } = idSchema.parse(input);
        await service.removeNetwork(user, id);
        await recordAudit({
            actorId: user.id,
            action: "vpn.network.remove",
            targetType: "vpnNetwork",
            targetId: id
        });
        return {};
    } catch (error) {
        return failed(error);
    }
}
