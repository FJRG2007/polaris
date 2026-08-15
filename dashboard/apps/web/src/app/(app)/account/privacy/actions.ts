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
import { setPrivacy } from "@/lib/privacy-service";
import {
    FriendError,
    removeFriend,
    requestFriend,
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

export async function requestFriendAction(userId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    return guard(() => requestFriend(user.id, String(userId)));
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
