"use server";

/** Where a machine is on the network, for whoever owns it. A machine lent to the
 *  reader answers nothing, the same as one that does not exist. */

import { z } from "zod";
import { listHosts } from "@/lib/host-service";
import { getHostLanIp } from "@/lib/host-address";
import { networkDetails } from "@/lib/network-details";
import { requireUser, sessionCan } from "@/lib/session";
import { LOCAL_SERVER_ID, type LanDetails } from "@polaris/core";
import * as machines from "@/lib/machines/machines-service";
import type { WatchCard } from "@/lib/watch-overview-service";

const idSchema = z.string().trim().min(1).max(64);

export async function machineNetworkAction(raw: unknown): Promise<LanDetails | null> {
    const user = await requireUser();
    const id = idSchema.safeParse(raw);
    if (!id.success || !(await sessionCan(user, "deploy.read"))) return null;
    if (id.data === LOCAL_SERVER_ID) return networkDetails(await getHostLanIp());
    const host = (await listHosts(user.id)).find((entry) => entry.id === id.data);
    return networkDetails(host?.address);
}

const pageInput = z
    .object({
        kind: z.enum(["servers", "containers", "domains"]),
        cursor: z.string().min(1).max(1024)
    })
    .strict();

/** The next page of one group on the machines list. Only the reader's own:
 *  what was lent to them is all on the first page. Null for a page that does
 *  not parse and for a reader without machines of their own. */
export async function machinePageAction(
    raw: unknown
): Promise<
    | { kind: "cards"; items: WatchCard[]; next: string | null }
    | { kind: "domains"; items: machines.DomainDevice[]; next: string | null }
    | null
> {
    const user = await requireUser();
    const input = pageInput.safeParse(raw);
    if (!input.success || !(await sessionCan(user, "deploy.read"))) return null;
    const { kind, cursor } = input.data;
    if (kind === "domains")
        return { kind: "domains", ...(await machines.machineDomainPage(user.id, cursor)) };
    const page =
        kind === "servers"
            ? await machines.machineServerPage(user.id, cursor)
            : await machines.machineContainerPage(user.id, cursor);
    return { kind: "cards", ...page };
}
