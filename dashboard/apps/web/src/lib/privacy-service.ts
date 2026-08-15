/**
 * Reading somebody's privacy settings, and answering "may this person see that".
 *
 * The rule itself is `core.audienceAllows` - pure, and testable without a
 * database. This is the part that needs one: the row, the friendship, and
 * whether the person looking administers the instance.
 *
 * Two things are stated here because they are easy to lose sight of:
 *
 * - An account with no row is on the defaults, which are the open ones. Absence
 *   is not a stricter setting; somebody who has never opened the screen has not
 *   asked for anything.
 * - An administrator sees everything. That is said in the copy on the screen
 *   too, because a setting that pretended otherwise would be a promise Polaris
 *   cannot keep - whoever runs the instance can read the database.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { areFriends } from "@/lib/friends-service";

export async function privacyFor(userId: string): Promise<core.PrivacySettings> {
    const row = await prisma.userPrivacy.findUnique({
        where: { userId },
        select: { lastSeen: true, readReceipts: true, avatar: true }
    });
    if (!row) return core.DEFAULT_PRIVACY;
    const parsed = core.privacySettingsSchema.safeParse(row);
    return parsed.success ? parsed.data : core.DEFAULT_PRIVACY;
}

export async function setPrivacy(
    userId: string,
    settings: core.PrivacySettings
): Promise<void> {
    await prisma.userPrivacy.upsert({
        where: { userId },
        create: { userId, ...settings },
        update: settings
    });
}

/** Who is asking, as every check below needs them. */
export interface PrivacyViewer {
    readonly id: string;
    readonly isAdmin: boolean;
}

/**
 * Whether this viewer may see one thing about one person.
 *
 * The friendship is only looked up when the setting actually turns on it, which
 * is the uncommon case - most accounts are on `everyone` and most checks end
 * before touching a second table.
 */
export async function maySee(
    subjectId: string,
    field: keyof core.PrivacySettings,
    viewer: PrivacyViewer
): Promise<boolean> {
    if (subjectId === viewer.id || viewer.isAdmin) return true;

    const settings = await privacyFor(subjectId);
    const audience = settings[field];
    if (audience === "everyone") return true;
    if (audience === "nobody") return false;

    return core.audienceAllows(audience, {
        self: false,
        friends: await areFriends(subjectId, viewer.id),
        viewerIsAdmin: false
    });
}

/**
 * Whether ticks may be drawn between these two people.
 *
 * Reciprocal, and that is the whole point of the function existing rather than
 * two `maySee` calls at the call site: somebody who hides that they read a
 * message does not get to see that theirs was read. A one-way version of this is
 * not a privacy setting, it is a mirror.
 *
 * An administrator sees them either way, like everything else.
 */
export async function receiptsBetween(viewer: PrivacyViewer, otherId: string): Promise<boolean> {
    if (viewer.isAdmin) return true;
    if (viewer.id === otherId) return true;

    const [mine, theirs] = await Promise.all([
        privacyFor(viewer.id),
        privacyFor(otherId)
    ]);
    if (mine.readReceipts === "nobody" || theirs.readReceipts === "nobody") return false;
    if (mine.readReceipts === "everyone" && theirs.readReceipts === "everyone") return true;

    // At least one of them said "friends", so the answer is whether they are.
    return areFriends(viewer.id, otherId);
}
