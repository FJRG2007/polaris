"use server";

/**
 * Profile self-service actions. Each re-resolves the session, so a user can only
 * ever change their own profile or email. The credential work (verify, hash)
 * lives in @polaris/auth so there is one source of truth for how passwords are
 * stored; password and security settings live under ./security.
 */

import { revalidatePath } from "next/cache";
import { changeUserEmail, updateUserProfile } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { auth } from "@/lib/auth";

export async function updateProfileAction(input: {
    name?: string;
    username?: string | null;
}): Promise<{ error?: string }> {
    const user = await requireUser();
    const result = await updateUserProfile(user.id, {
        name: typeof input.name === "string" ? input.name : undefined,
        username: input.username === undefined ? undefined : (input.username ?? "")
    });
    if (!result.error) revalidatePath("/account");
    return result;
}

export async function changeEmailAction(newEmail: string, currentPassword: string): Promise<{ error?: string }> {
    const user = await requireUser();
    const result = await changeUserEmail(auth, user.id, String(newEmail), String(currentPassword));
    if (!result.error) revalidatePath("/account");
    return result;
}
