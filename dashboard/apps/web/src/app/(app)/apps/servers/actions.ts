"use server";

/**
 * Servers app server actions. A Host is an SSH server registered once and reused
 * by Containers (Docker over SSH) and Drive (SFTP). Hosts are owner-scoped;
 * creating one test-connects to validate credentials and pin the host key before
 * anything is stored, so a bad host fails fast with a clear message.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createHostSchema, setServerEnvironmentSchema } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { setLocalEnvironment } from "@/lib/network-service";
import { createHost, deleteHost, setHostEnvironment, setHostWildcardDomain } from "@/lib/host-service";

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

/**
 * Record where a server lives. A null `hostId` means the box Polaris runs on,
 * whose classification is global config rather than a Host row. The answer always
 * wins over detection: no probe can see a router's port forwarding from inside.
 */
export async function setServerEnvironmentAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = setServerEnvironmentSchema.safeParse(input);
    if (!parsed.success) return { error: "Invalid server environment" };
    const { hostId, environment } = parsed.data;
    if (hostId) {
        if (!(await setHostEnvironment(user.id, hostId, environment))) return { error: "Server not found" };
    } else {
        await setLocalEnvironment(environment);
    }
    await recordAudit({
        actorId: user.id,
        action: "server.environment",
        targetType: hostId ? "host" : "system",
        targetId: hostId ?? "local",
        metadata: { environment }
    });
    revalidatePath(SERVERS_PATH);
    return {};
}

const serverWildcardSchema = z.object({
    hostId: z.string().uuid(),
    /** Blank clears it, so the server falls back to IP-derived free subdomains. */
    wildcardDomain: z.string().max(253)
});

/**
 * Point a wildcard domain at one server. Services deployed there then get a real
 * domain from that server's own edge instead of a hostname built from its IP - the
 * per-server equivalent of the Polaris host's zone layout, and the only thing that
 * gives a server reached by hostname any subdomain at all.
 */
export async function setServerWildcardAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = serverWildcardSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid domain" };
    try {
        if (!(await setHostWildcardDomain(user.id, parsed.data.hostId, parsed.data.wildcardDomain))) {
            return { error: "Server not found" };
        }
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the domain" };
    }
    await recordAudit({
        actorId: user.id,
        action: "server.wildcard",
        targetType: "host",
        targetId: parsed.data.hostId
    });
    revalidatePath(SERVERS_PATH);
    return {};
}

export async function deleteHostAction(hostId: string): Promise<void> {
    const user = await requirePermission("system.manage");
    await deleteHost(user.id, hostId);
    await recordAudit({ actorId: user.id, action: "host.delete", targetType: "host", targetId: hostId });
    revalidatePath(SERVERS_PATH);
}
