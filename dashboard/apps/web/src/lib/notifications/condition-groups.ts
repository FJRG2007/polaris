/**
 * Conditions that start and end for several things at once.
 *
 * A checker sweeping many addresses or domains sees them fail together and come
 * back together. One notice per thing is the bell full of copies this exists to
 * prevent, so what failed in one pass is one notice (its members kept in the
 * metadata), and a recovery closes the notice that announced the failure,
 * rewritten with the good news, instead of writing another row beside it.
 */

import { notify, type NotifyInput, type NotifyReport } from "./dispatch";
import { openConditions, raiseCondition, resolveCondition } from "@/lib/notification-service";
import type { NotificationLevel } from "@polaris/core";

/** The words a group's notice is rewritten with. */
export interface GroupText {
    title: string;
    body: string;
    level?: NotificationLevel;
}

function membersOf(metadata: Record<string, unknown>): string[] {
    const members = metadata.members;
    return Array.isArray(members) ? members.filter((member): member is string => typeof member === "string") : [];
}

/**
 * Raise one notice for everything in `members` that went wrong in this pass. The
 * key is the prefix and the first member, so a pass repeated while they are
 * still down rewrites the same notice.
 */
export async function raiseGroup(
    prefix: string,
    members: readonly string[],
    input: Omit<NotifyInput, "condition">
): Promise<NotifyReport> {
    const sorted = [...new Set(members)].sort();
    return notify({
        ...input,
        condition: `${prefix}${sorted[0] ?? ""}`,
        metadata: { ...input.metadata, members: sorted }
    });
}

/**
 * For one reader: close every open notice under `prefix` that the recovered
 * members end, rewritten with `back(those members)`. A notice only some of whose
 * members recovered stays open, rewritten with `still(the rest)`. Answers the
 * recovered members no open notice covered - a failure announced before this
 * existed, or never announced - for the caller to tell as it always did.
 */
export async function settleGroup(
    userId: string,
    prefix: string,
    recovered: readonly string[],
    back: (members: readonly string[]) => GroupText,
    still: (remaining: readonly string[]) => GroupText
): Promise<string[]> {
    const left = new Set(recovered);
    if (left.size === 0) return [];
    for (const open of await openConditions(userId, prefix)) {
        const members = membersOf(open.metadata);
        const ended = members.filter((member) => left.has(member));
        if (ended.length === 0) continue;
        for (const member of ended) left.delete(member);
        const remaining = members.filter((member) => !recovered.includes(member));
        if (remaining.length === 0) {
            const text = back(ended);
            await resolveCondition(open.conditionKey, {
                userIds: [userId],
                recovery: { ...text, level: text.level ?? "success", metadata: { ...open.metadata, members } }
            });
        } else {
            const text = still(remaining);
            await raiseCondition(open.conditionKey, {
                userId,
                type: open.type,
                ...text,
                level: text.level ?? "warning",
                actionRequired: true,
                metadata: { ...open.metadata, members: remaining }
            });
        }
    }
    return [...left];
}
