"use server";

/**
 * Saving what this account is willing to show, and answering friend requests.
 *
 * Every one of these is about the caller's own account. There is no id in any
 * signature for that reason: an action that took one would be an action that
 * could be pointed at somebody else.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { findPeople } from "@/lib/people-search";
import { setPrivacy } from "@/lib/privacy-service";
import {
    FriendError,
    removeFriend,
    requestFriend,
    requestFriendByUsername,
    respondToRequest
} from "@/lib/friends-service";

const PRIVACY_PATH = "/account/privacy";

async function guard(run: () => Promise<void>): Promise<{ error?: string }> {
    try {
        await run();
        revalidatePath(PRIVACY_PATH);
        return {};
    } catch (caught) {
        if (caught instanceof FriendError) return { error: caught.message };
        throw caught;
    }
}

export async function savePrivacyAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = core.privacySettingsSchema.safeParse(input);
    if (!parsed.success) return { error: "Those settings could not be saved" };

    await setPrivacy(user.id, parsed.data);
    revalidatePath(PRIVACY_PATH);
    return {};
}

/**
 * Who this account may ask to be friends with.
 *
 * Its own search rather than the chat one, and the reason is a bug this fixed:
 * the friends card borrowed Chat's, whose first act is to check `chat.use` - so
 * an account without the chat was sent away from its own privacy screen the
 * moment the picker mounted, by a redirect it never asked for. Being friends is
 * not a chat feature; it decides what the settings above this mean.
 */
export async function searchForFriendAction(
    query: string
): Promise<{ results?: { id: string; name: string }[]; withheld?: number }> {
    const user = await requireUser();
    const found = await findPeople(user, String(query ?? ""), { reachableOnly: false });
    return { results: found.people, withheld: 0 };
}

export async function requestFriendAction(userId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    return guard(() => requestFriend(user.id, String(userId)));
}

/**
 * Ask somebody by the username they gave you.
 *
 * Answers the same way whether or not there was anybody there. A reply that
 * distinguished the two would let anybody find out which usernames exist by
 * typing them one at a time, which is the exact thing "nobody can find me" is
 * for.
 */
export async function requestFriendByUsernameAction(
    username: string
): Promise<{ said: string; error?: string }> {
    const user = await requireUser();
    const result = await guard(() => requestFriendByUsername(user.id, String(username ?? "")));
    if (result.error) return { said: "", error: result.error };
    return { said: "If that account exists, it has been asked." };
}

export async function respondToRequestAction(
    requestId: string,
    accept: boolean
): Promise<{ error?: string }> {
    const user = await requireUser();
    return guard(() => respondToRequest(user.id, String(requestId), Boolean(accept)));
}

export async function removeFriendAction(userId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    return guard(() => removeFriend(user.id, String(userId)));
}
