"use server";

/**
 * What one person may do about another from their page.
 *
 * Every one of these already exists somewhere in Polaris - a friend request is
 * the friends screen's, a conversation is the chat's - and this is deliberately
 * a way in rather than a second implementation: the refusals, the blocks and the
 * rate limits all belong where they already are, and a profile that reimplemented
 * any of them would be the place they drift apart.
 *
 * The one thing genuinely new is following, which nothing else in Polaris does
 * between two people yet.
 *
 * Every action names the other person and nothing else. There is no id for whose
 * account is acting, and that is deliberate: an action that took one would be an
 * action that could be pointed at somebody else's relationships.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { FriendError, removeFriend, requestFriend } from "@/lib/friends-service";
import { FollowError, followPerson, listFollow, unfollowPerson } from "@/lib/people-follow";

const personSchema = z.object({ personId: z.string().uuid() });

/** One sentence, whichever of the two threw it. Anything else is logged and
 *  replaced: those messages name internals nobody asked to publish. */
function refusal(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof FollowError || caught instanceof FriendError) return { error: caught.message };
    console.error("polaris: a profile action failed:", caught);
    return { error: fallback };
}

export async function followAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = personSchema.safeParse(input);
    if (!parsed.success) return { error: "There is nobody to follow here" };
    try {
        await followPerson(user.id, parsed.data.personId);
        return {};
    } catch (caught) {
        return refusal(caught, "That could not be done");
    }
}

export async function unfollowAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = personSchema.safeParse(input);
    if (!parsed.success) return {};
    await unfollowPerson(user.id, parsed.data.personId);
    return {};
}

/** Ask to be added. The friends service owns every refusal, including the ones
 *  that must not say which of them applied. */
export async function askToBeFriendsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = personSchema.safeParse(input);
    if (!parsed.success) return { error: "That request could not be sent" };
    try {
        await requestFriend(user.id, parsed.data.personId);
        revalidatePath("/account/friends");
        return {};
    } catch (caught) {
        return refusal(caught, "That request could not be sent");
    }
}

export async function stopBeingFriendsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = personSchema.safeParse(input);
    if (!parsed.success) return {};
    try {
        await removeFriend(user.id, parsed.data.personId);
        revalidatePath("/account/friends");
        return {};
    } catch (caught) {
        return refusal(caught, "That could not be done");
    }
}

const listSchema = z.object({
    personId: z.string().uuid(),
    which: z.enum(["followers", "following"]),
    before: z.string().datetime().nullable().optional()
});

/**
 * A page of one of the two lists.
 *
 * Guarded by the same setting that decides whether the counts are drawn at all:
 * a reader who may not see the numbers may not page through the names either,
 * and the check is here rather than only on the screen because the screen is not
 * what enforces anything.
 */
export async function loadFollowListAction(
    input: unknown
): Promise<{ items?: { id: string; name: string; username: string }[]; cursor?: string | null; error?: string }> {
    const user = await requireUser();
    const parsed = listSchema.safeParse(input);
    if (!parsed.success) return { error: "That list could not be read" };

    const { maySee } = await import("@/lib/privacy-service");
    const allowed = await maySee(parsed.data.personId, "followers", {
        id: user.id,
        isAdmin: user.isAdmin
    });
    if (!allowed) return { error: "That list is not shown" };

    const page = await listFollow(parsed.data.personId, parsed.data.which, {
        before: parsed.data.before ?? null
    });
    return { items: [...page.items], cursor: page.cursor };
}
