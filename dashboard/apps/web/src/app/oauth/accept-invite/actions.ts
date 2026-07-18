"use server";

/** Claim an invite. The email is fixed by the invite; the user sets name + password. */

import { acceptInviteSchema } from "@polaris/core";
import { acceptInvite } from "@/lib/invite-service";

export async function acceptInviteAction(input: {
    token: string;
    name: string;
    username: string;
    password: string;
}): Promise<{ error?: string }> {
    const parsed = acceptInviteSchema.safeParse({
        name: input.name,
        username: input.username,
        password: input.password
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    if (!input.token) return { error: "Missing invite token" };
    try {
        await acceptInvite(input.token, parsed.data.name, parsed.data.username, parsed.data.password);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not accept the invite" };
    }
}
