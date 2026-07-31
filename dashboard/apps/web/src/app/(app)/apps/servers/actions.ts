"use server";

/**
 * Servers app server actions. A Host is an SSH server registered once and reused
 * by Containers (Docker over SSH) and Drive (SFTP). Hosts are owner-scoped;
 * creating one test-connects to validate credentials and pin the host key before
 * anything is stored, so a bad host fails fast with a clear message.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { setLocalEnvironment } from "@/lib/network-service";
import { createEnrollmentSchema, createHostSchema, setServerEnvironmentSchema } from "@polaris/core";
import { createHost, deleteHost, setHostEnvironment, setHostWildcardDomain } from "@/lib/host-service";
import {
    cancelEnrollment,
    getEnrollmentStatus,
    openEnrollment,
    type EnrollmentStatus,
    type OpenedEnrollment
} from "@/lib/enrollment-service";

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

/**
 * Open a quick enrollment and hand back the command to run on the machine. The
 * command carries a token that is live for minutes, so it is generated when the
 * operator asks for it rather than kept on the page.
 */
export async function openEnrollmentAction(
    input: unknown
): Promise<{ enrollment?: OpenedEnrollment; error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = createEnrollmentSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid enrollment" };
    try {
        return { enrollment: await openEnrollment(user.id, parsed.data) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not start the enrollment" };
    }
}

/** Polled by the dialog while it waits for the machine to call home. */
export async function enrollmentStatusAction(id: string): Promise<EnrollmentStatus | null> {
    const user = await requirePermission("system.manage");
    const status = await getEnrollmentStatus(id, user.id);
    // A finished enrollment added a row the list does not know about yet.
    if (status?.state === "claimed") revalidatePath(SERVERS_PATH);
    return status;
}

/** Kill a command that was generated and should not be used after all. */
export async function cancelEnrollmentAction(id: string): Promise<void> {
    const user = await requirePermission("system.manage");
    await cancelEnrollment(id, user.id);
}

export async function deleteHostAction(hostId: string): Promise<void> {
    const user = await requirePermission("system.manage");
    await deleteHost(user.id, hostId);
    await recordAudit({ actorId: user.id, action: "host.delete", targetType: "host", targetId: hostId });
    revalidatePath(SERVERS_PATH);
}
