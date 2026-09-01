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
import * as notes from "@/lib/server-notes-service";
import type { CommentView } from "@/lib/comments/comments";
import type { ActivityLine } from "@/lib/activity/activity";
import type { ServerMetrics } from "@/lib/server-probe";
import { setLocalEnvironment } from "@/lib/network-service";
import { getServerMetrics } from "@/lib/server-metrics-service";
import { hostSpace, reclaimHostSpace, type HostSpace } from "@/lib/deploy/host-space";
import { hostVolumes, removeHostVolume, type HostVolume } from "@/lib/deploy/host-volumes";
import {
    removeStrayContainer,
    strayContainers,
    type StrayContainer
} from "@/lib/deploy/host-containers";
import { getLocalHostId, setLocalHostId, setLocalServerName } from "@/lib/local-server";
import { createHost, renameHost, setHostEnvironment, setHostWildcardDomain } from "@/lib/host-service";
import {
    createEnrollmentSchema,
    createHostSchema,
    removeServerSchema,
    renameServerSchema,
    subjectCommentSchema,
    setServerEnvironmentSchema
} from "@polaris/core";
import {
    cancelEnrollment,
    getEnrollmentStatus,
    openEnrollment,
    type EnrollmentStatus,
    type OpenedEnrollment
} from "@/lib/enrollment-service";
import {
    createHostGroup,
    deleteHostGroup,
    listHostGroups,
    renameHostGroup,
    setHostGroupMembers,
    type HostGroupView
} from "@/lib/host-group-service";
import {
    getServerRemovalPlan,
    removeServer,
    type RemoveServerResult,
    type ServerRemovalMode,
    type ServerRemovalPlan
} from "@/lib/server-removal-service";

const SERVERS_PATH = "/apps/servers";

/** What has happened to this server. */
export async function serverHistoryAction(hostId: string): Promise<ActivityLine[]> {
    const user = await requirePermission("system.manage");
    try {
        return await notes.serverHistory(hostId, user.id);
    } catch {
        return [];
    }
}

/** What people have written down about it. */
export async function serverNotesAction(hostId: string): Promise<CommentView[]> {
    const user = await requirePermission("system.manage");
    try {
        return await notes.serverNotes(hostId, user.id);
    } catch {
        return [];
    }
}

export async function postServerNoteAction(input: { hostId: string; body: string }): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = subjectCommentSchema.safeParse({ subjectId: input.hostId, body: input.body });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That note cannot be posted" };
    try {
        await notes.postServerNote(parsed.data.subjectId, user.id, parsed.data.body);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not post the note" };
    }
}

export async function deleteServerNoteAction(input: {
    hostId: string;
    commentId: string;
}): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        await notes.deleteServerNote(input.hostId, user.id, input.commentId);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete the note" };
    }
}

/** Whether the reader hears about this server, and changing that. */
export async function serverFollowStateAction(hostId: string): Promise<{ following: boolean }> {
    const user = await requirePermission("system.manage");
    try {
        return { following: await notes.isFollowingServer(hostId, user.id) };
    } catch {
        return { following: false };
    }
}

export async function setServerFollowAction(input: {
    hostId: string;
    following: boolean;
}): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        await notes.setFollowingServer(input.hostId, user.id, input.following);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change that" };
    }
}

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
    if (hostId) await notes.recordServerEvent(hostId, user.id, "environment", { to: environment });
    revalidatePath(SERVERS_PATH);
    return {};
}

/**
 * Rename a server. A null `hostId` means the box Polaris runs on: it has no Host
 * row, so its name is a setting, and clearing it puts the machine's own name back
 * rather than leaving a server with no label.
 */
export async function renameServerAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = renameServerSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid name" };
    const { hostId, name } = parsed.data;
    if (hostId) {
        if (!name) return { error: "Name this server" };
        if (!(await renameHost(user.id, hostId, name))) return { error: "Server not found" };
    } else {
        await setLocalServerName(name);
    }
    await recordAudit({
        actorId: user.id,
        action: "server.rename",
        targetType: hostId ? "host" : "system",
        targetId: hostId ?? "local",
        metadata: { name }
    });
    if (hostId) await notes.recordServerEvent(hostId, user.id, "renamed", { to: name });
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

/**
 * What a server is running and what is eating it, for the panel behind a row.
 *
 * A machine that is off, unreachable or slow is an ordinary outcome here, not an
 * error worth throwing: the panel says it could not read the server and everything
 * else on screen stays usable.
 */
export async function serverMetricsAction(hostId: string): Promise<ServerMetrics | null> {
    const user = await requirePermission("system.manage");
    try {
        return await getServerMetrics(hostId, user.id);
    } catch {
        return null;
    }
}

/** What removing this server would take with it, for the confirmation dialog. */
export async function serverRemovalPlanAction(hostId: string): Promise<ServerRemovalPlan | null> {
    const user = await requirePermission("system.manage");
    return getServerRemovalPlan(user.id, hostId);
}

/**
 * Remove a server the way the operator chose. Moving services can take minutes -
 * it is a real deploy per service, waited on - so this is one long action rather
 * than a fire-and-forget: the dialog stays open on it and reports what happened.
 */
export async function removeServerAction(
    hostId: string,
    input: { mode: ServerRemovalMode; destinationId?: string }
): Promise<RemoveServerResult> {
    const user = await requirePermission("system.manage");
    const parsed = removeServerSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid removal" };

    const result = await removeServer(user.id, hostId, user.id, parsed.data);
    if (result.error) return result;

    if ((await getLocalHostId()) === hostId) await setLocalHostId(null);
    // The history, the notes and the followers were about a server that is gone.
    // None of them cascades, so removing it says so.
    await notes.forgetServer(hostId);
    await recordAudit({
        actorId: user.id,
        action: "host.delete",
        targetType: "host",
        targetId: hostId,
        metadata: { mode: parsed.data.mode, moved: result.moved?.length ?? 0 }
    });
    revalidatePath(SERVERS_PATH);
    return result;
}

/** The owner's server groups, with membership, for the groups panel. */
export async function listHostGroupsAction(): Promise<HostGroupView[]> {
    const user = await requirePermission("system.manage");
    return listHostGroups(user.id);
}

export async function createHostGroupAction(name: string): Promise<{ id?: string; error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        const group = await createHostGroup(user.id, name);
        await recordAudit({ actorId: user.id, action: "host.group.create", targetType: "hostGroup", targetId: group.id });
        revalidatePath(SERVERS_PATH);
        return { id: group.id };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the group" };
    }
}

export async function renameHostGroupAction(groupId: string, name: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        await renameHostGroup(user.id, groupId, name);
        revalidatePath(SERVERS_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not rename the group" };
    }
}

/** Delete a group. Its firewall rules go with it - see deleteHostGroup. */
export async function deleteHostGroupAction(groupId: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        await deleteHostGroup(user.id, groupId);
        await recordAudit({ actorId: user.id, action: "host.group.delete", targetType: "hostGroup", targetId: groupId });
        revalidatePath(SERVERS_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete the group" };
    }
}

export async function setHostGroupMembersAction(groupId: string, hostIds: string[]): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        await setHostGroupMembers(user.id, groupId, hostIds);
        revalidatePath(SERVERS_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the group" };
    }
}

/**
 * What the container store is holding on the machine Polaris runs on.
 *
 * Only that machine: it is the one Polaris can reach through its own daemon,
 * and the one whose disk filling up stops Polaris itself from deploying. Null
 * where the daemon cannot answer, which a screen reads as "cannot say" rather
 * than as "nothing".
 *
 * Behind the same gate as everything else on this screen: what it reports is how
 * the machine Polaris runs on is being used.
 */
export async function hostSpaceAction(): Promise<HostSpace | null> {
    await requirePermission("system.manage");
    return hostSpace().catch(() => null);
}

/**
 * Hand back the room that holds nothing anybody wrote.
 *
 * Audited, because it removes things - even though the things are
 * regenerable. What it can reach is bounded by the daemon's own allowlist, and
 * volumes are not on it.
 */
export async function reclaimHostSpaceAction(): Promise<{ freed?: number; error?: string }> {
    const user = await requirePermission("system.manage");
    const freed = await reclaimHostSpace().catch(() => null);
    if (freed === null) {
        return { error: "This machine would not say. Nothing was removed." };
    }
    await recordAudit({
        actorId: user.id,
        action: "server.space.reclaimed",
        targetType: "host",
        targetId: "local",
        metadata: { freed }
    });
    revalidatePath("/apps/servers");
    return { freed };
}

/**
 * Every volume on the machine Polaris runs on, and what it knows about each.
 *
 * The list a person reads before deleting anything, which is the whole point:
 * the alternative on offer everywhere else is a prune that decides for itself.
 */
export async function hostVolumesAction(): Promise<HostVolume[] | null> {
    await requirePermission("system.manage");
    return hostVolumes().catch(() => null);
}

/**
 * Remove one volume, named in full by whoever is looking at it.
 *
 * Audited with its size, because this is the one thing on the storage screen
 * that does not come back: a rebuilt layer costs time, a deleted volume costs
 * whatever was written in it. The checks that decide whether it may go at all
 * are in `host-volumes.ts`, re-run there at the moment of the call.
 */
export async function removeHostVolumeAction(name: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const volumes = await hostVolumes().catch(() => null);
    const before = volumes?.find((volume) => volume.name === name) ?? null;

    const result = await removeHostVolume(name).catch(() => null);
    if (!result) return { error: "This machine would not answer. Nothing was removed." };
    if (!result.ok) return { error: result.reason };

    await recordAudit({
        actorId: user.id,
        action: "server.volume.removed",
        targetType: "volume",
        targetId: name,
        metadata: { bytes: before?.bytes ?? null, project: before?.project ?? null }
    });
    revalidatePath(SERVERS_PATH);
    return {};
}

/** The containers Polaris deployed here and no longer has a record of. Null when
 *  the machine would not say, which is not the same as none. */
export async function strayContainersAction(): Promise<StrayContainer[] | null> {
    await requirePermission("system.manage");
    return strayContainers().catch(() => null);
}

/**
 * Remove one container Polaris left behind.
 *
 * Audited with what it was, because this is Polaris tidying up after itself and
 * the record of that belongs beside the deploys that made it. The checks that
 * decide whether it may go at all are in `host-containers.ts`, re-run there at
 * the moment of the call - and its volumes are deliberately not taken with it.
 */
export async function removeStrayContainerAction(id: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const strays = await strayContainers().catch(() => null);
    const before = strays?.find((entry) => entry.id === id) ?? null;

    const result = await removeStrayContainer(id).catch(() => null);
    if (!result) return { error: "This machine would not answer. Nothing was removed." };
    if (!result.ok) return { error: result.reason };

    await recordAudit({
        actorId: user.id,
        action: "server.container.removed",
        targetType: "container",
        targetId: id,
        metadata: { name: before?.name ?? null, project: before?.project ?? null, image: before?.image ?? null }
    });
    revalidatePath(SERVERS_PATH);
    return {};
}
