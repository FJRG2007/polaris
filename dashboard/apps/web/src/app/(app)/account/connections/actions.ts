"use server";

/**
 * Connecting and disconnecting one's own outside accounts.
 *
 * Self-service only: the session is re-resolved in every action, so nothing here
 * can link or unlink somebody else's account whatever the form sends. A browser
 * Polaris has only just met waits out its grace period first, for the same reason
 * it does on the security screens - a linked account reaches private code.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { newDeviceRefusal } from "@/lib/device-grace";
import { readGithubAccount } from "@/lib/github-service";
import { ConnectionClaimedError, ConnectionLimitError, deleteConnection, saveConnection } from "@/lib/connections/store";

const CONNECTIONS_PATH = "/account/connections";

const connectionIdSchema = z.string().uuid();
const tokenSchema = z.string().trim().min(1, "Paste the token first").max(500);

/**
 * Link a GitHub account with a personal access token instead of authorizing.
 *
 * The token is validated against GitHub before anything is stored, so the account
 * on the card is the one GitHub says the token speaks for and not a login
 * somebody typed. Kept as an option because a deployment whose operator has not
 * connected a GitHub App has no authorization screen to send anybody to.
 */
export async function connectGithubTokenAction(rawToken: string): Promise<{ error?: string; login?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    const parsed = tokenSchema.safeParse(rawToken);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Paste the token first" };

    try {
        const account = await readGithubAccount(parsed.data);
        await saveConnection(user.id, {
            provider: "github",
            accountId: String(account.id),
            label: account.login,
            avatarUrl: account.avatarUrl,
            method: "token",
            credential: { token: parsed.data }
        });
        revalidatePath(CONNECTIONS_PATH);
        return { login: account.login };
    } catch (caught) {
        if (caught instanceof ConnectionClaimedError || caught instanceof ConnectionLimitError) {
            return { error: caught.message };
        }
        return { error: caught instanceof Error ? caught.message : "Could not connect the account" };
    }
}

/** Forget one linked account. */
export async function disconnectAccountAction(connectionId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    const parsed = connectionIdSchema.safeParse(connectionId);
    if (!parsed.success) return { error: "Unknown account" };

    const removed = await deleteConnection(user.id, parsed.data);
    if (!removed) return { error: "That account is not linked to your profile" };
    revalidatePath(CONNECTIONS_PATH);
    return {};
}
