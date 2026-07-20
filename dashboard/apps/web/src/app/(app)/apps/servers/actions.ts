"use server";

/**
 * Servers app server actions. A Host is an SSH server registered once and reused
 * by Containers (Docker over SSH) and Drive (SFTP). Hosts are owner-scoped;
 * creating one test-connects to validate credentials and pin the host key before
 * anything is stored, so a bad host fails fast with a clear message.
 */

import { revalidatePath } from "next/cache";
import { createHostSchema } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import { createHost, deleteHost } from "@/lib/host-service";
import { recordAudit } from "@/lib/audit-service";

const SERVERS_PATH = "/apps/servers";

export async function createHostAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = createHostSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid host" };
    try {
        const created = await createHost(user.id, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "host.create",
            targetType: "host",
            targetId: created.id,
            metadata: { name: parsed.data.name, address: parsed.data.config.address }
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not connect to the host" };
    }
    revalidatePath(SERVERS_PATH);
    return {};
}

export async function deleteHostAction(hostId: string): Promise<void> {
    const user = await requirePermission("system.manage");
    await deleteHost(user.id, hostId);
    await recordAudit({ actorId: user.id, action: "host.delete", targetType: "host", targetId: hostId });
    revalidatePath(SERVERS_PATH);
}
