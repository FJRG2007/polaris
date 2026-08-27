"use server";

/**
 * Sharing a file or folder with somebody on this instance.
 *
 * Everything here is an ownership operation: only whoever owns the storage the
 * item is on (or an administrator) may hand it out, so somebody who was given
 * write access cannot pass it on. That rule is the same one the access rules
 * screen enforces, and is checked here rather than trusted from the browser.
 *
 * Who may be offered as a recipient is a privacy question, not a Drive one, so
 * it goes through the instance's people search: nothing is listed, a search of
 * one letter finds nobody, and anybody who has taken themselves out of being
 * found stays out of it. A Drive screen is not a way around that.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { getUserGroupIds } from "@polaris/auth";
import { findPeople } from "@/lib/people-search";
import { DRIVE_GRANT_NOTE_MAX, normalizeRelPath } from "@polaris/core";
import type { ItemShare } from "./sharing-types";
import { recordAudit } from "@/lib/audit-service";
import { listDriveAcls } from "@/lib/drive-acl-service";
import {
    DRIVE_SHARE_ROLES,
    listSharedByMe,
    listSharedWithMe,
    shareRoleOf,
    shareWithPerson,
    stopSharing,
    type SharedItem,
    type SharePerson
} from "@/lib/drive-sharing";

/** Ensure the caller owns the storage the item is on (or is an admin). */
async function requireOwner(connectionId: string): Promise<string> {
    const user = await requireUser();
    if (user.isAdmin) return user.id;
    const owns = await prisma.storageConnection.count({
        where: { id: connectionId, ownerId: user.id }
    });
    if (owns === 0) throw new Error("Only the owner can share this");
    return user.id;
}

/** Who this account may offer the item to. Two letters at least, nothing listed. */
export async function findSharePeopleAction(
    query: string
): Promise<{ results?: { id: string; name: string }[]; withheld?: number }> {
    const user = await requireUser();
    // Not `reachableOnly`: this is not a message, and somebody with the chat
    // switched off can still be given a folder.
    const found = await findPeople(user, String(query ?? ""), { reachableOnly: false });
    return { results: found.people, withheld: found.withheld };
}

/**
 * The groups this account may share with.
 *
 * Its own, and no others. A group is a list of people, so offering every group
 * on the instance would answer "who is organised into what here" to anybody with
 * a file - which is the same directory question the people search refuses.
 */
export async function myShareGroupsAction(): Promise<SharePerson[]> {
    const user = await requireUser();
    // An administrator already runs the groups screen, so withholding the list
    // from them would only mean opening another tab to read it.
    const ids = user.isAdmin ? null : await getUserGroupIds(user.id);
    if (ids && ids.length === 0) return [];
    const groups = await prisma.group.findMany({
        where: ids ? { id: { in: ids } } : {},
        orderBy: { name: "asc" },
        select: { id: true, name: true }
    });
    return groups.map((group) => ({ type: "group" as const, id: group.id, name: group.name }));
}

/**
 * What a share request may say.
 *
 * A server action is an endpoint: the shape the browser sends is checked here
 * rather than trusted from the dialog that usually sends it, so a hand-made call
 * cannot write a grant naming nobody or a note nothing would ever display.
 */
const shareItemSchema = z.object({
    connectionId: z.string().min(1),
    path: z.string(),
    principalType: z.enum(["user", "group"]),
    principalId: z.string().uuid("Choose who to share it with"),
    role: z.enum(DRIVE_SHARE_ROLES),
    note: z.string().trim().max(DRIVE_GRANT_NOTE_MAX, "That note is too long").optional(),
    /** A date, as the browser's date field writes it. Empty means indefinite. */
    expiresAt: z.string().optional()
});

/** Give somebody an item, or change what they may do with one they already have. */
export async function shareItemAction(
    input: z.input<typeof shareItemSchema>
): Promise<{ error?: string }> {
    const parsed = shareItemSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "That is not something to share" };
    }
    const share = parsed.data;
    const userId = await requireOwner(share.connectionId);

    const expiresAt = share.expiresAt ? new Date(share.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) return { error: "That date is not a date" };
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
        return { error: "Choose a date in the future" };
    }

    try {
        await shareWithPerson({
            connectionId: share.connectionId,
            path: share.path,
            principalType: share.principalType,
            principalId: share.principalId,
            role: share.role,
            note: share.note ?? null,
            expiresAt,
            sharedById: userId
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not share it" };
    }

    await recordAudit({
        actorId: userId,
        action: "drive.share.person",
        targetType: "connection",
        targetId: share.connectionId,
        metadata: {
            path: normalizeRelPath(share.path),
            principal: `${share.principalType}:${share.principalId}`,
            role: share.role
        }
    });
    revalidatePath("/drive");
    revalidatePath("/drive/shared");
    return {};
}

/** Take a share back. */
export async function stopSharingAction(
    connectionId: string,
    grantId: string
): Promise<{ error?: string }> {
    let userId: string;
    try {
        userId = await requireOwner(connectionId);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Only the owner can do that" };
    }
    await stopSharing(connectionId, grantId);
    await recordAudit({
        actorId: userId,
        action: "drive.share.stop",
        targetType: "connection",
        targetId: connectionId,
        metadata: { grantId }
    });
    revalidatePath("/drive");
    revalidatePath("/drive/shared");
    return {};
}

/** Who currently holds one item, for the share dialog's "people with access". */
export async function listItemSharesAction(
    connectionId: string,
    path: string
): Promise<{ people: ItemShare[]; error?: string }> {
    try {
        await requireOwner(connectionId);
    } catch (caught) {
        return {
            people: [],
            error: caught instanceof Error ? caught.message : "Only the owner can see this"
        };
    }
    const wanted = normalizeRelPath(path);
    const grants = (await listDriveAcls(connectionId)).filter(
        (grant) => grant.path === wanted && grant.effect === "allow"
    );
    if (grants.length === 0) return { people: [] };

    const userIds = grants.filter((g) => g.principalType === "user").map((g) => g.principalId);
    const groupIds = grants.filter((g) => g.principalType === "group").map((g) => g.principalId);
    const [users, groups] = await Promise.all([
        userIds.length === 0
            ? []
            : prisma.user.findMany({
                  where: { id: { in: userIds } },
                  select: { id: true, name: true }
              }),
        groupIds.length === 0
            ? []
            : prisma.group.findMany({
                  where: { id: { in: groupIds } },
                  select: { id: true, name: true }
              })
    ]);
    const names = new Map<string, string>([
        ...users.map((row) => [`user:${row.id}`, row.name] as const),
        ...groups.map((row) => [`group:${row.id}`, row.name] as const)
    ]);

    return {
        people: grants.map((grant) => ({
            grantId: grant.id,
            type: grant.principalType === "group" ? "group" : "user",
            id: grant.principalId,
            name:
                names.get(`${grant.principalType}:${grant.principalId}`) ??
                "Someone who is no longer here",
            role: shareRoleOf(grant.actions),
            expiresAt: grant.expiresAt?.toISOString() ?? null
        }))
    };
}

/** What has been shared with this account, for the Shared with me screen. */
export async function sharedWithMeAction(): Promise<SharedItem[]> {
    const user = await requireUser();
    return listSharedWithMe(user.id);
}

/** What this account has shared out. */
export async function sharedByMeAction(): Promise<SharedItem[]> {
    const user = await requireUser();
    return listSharedByMe(user.id);
}
