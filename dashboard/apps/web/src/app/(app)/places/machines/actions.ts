"use server";

/** Where a machine is on the network, for whoever owns it. A machine lent to the
 *  reader answers nothing, the same as one that does not exist. */

import { z } from "zod";
import { listHosts } from "@/lib/host-service";
import { getHostLanIp } from "@/lib/host-address";
import { networkDetails } from "@/lib/network-details";
import { requireUser, sessionCan } from "@/lib/session";
import { LOCAL_SERVER_ID, type LanDetails } from "@polaris/core";

const idSchema = z.string().trim().min(1).max(64);

export async function machineNetworkAction(raw: unknown): Promise<LanDetails | null> {
    const user = await requireUser();
    const id = idSchema.safeParse(raw);
    if (!id.success || !(await sessionCan(user, "deploy.read"))) return null;
    if (id.data === LOCAL_SERVER_ID) return networkDetails(await getHostLanIp());
    const host = (await listHosts(user.id)).find((entry) => entry.id === id.data);
    return networkDetails(host?.address);
}
