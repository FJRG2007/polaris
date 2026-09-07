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
import { awsIdentity } from "@/lib/integrations/aws-api";
import { vercelUser } from "@/lib/integrations/vercel-api";
import { railwayAccount } from "@/lib/integrations/railway-api";
import { ConnectionClaimedError, ConnectionLimitError, deleteConnection, saveConnection } from "@/lib/connections/store";

const CONNECTIONS_PATH = "/account/connections";

const connectionIdSchema = z.string().uuid();
const tokenSchema = z.string().trim().min(1, "Paste the token first").max(500);

/**
 * Who a pasted token turns out to belong to, per service.
 *
 * Every one of these is a call to the provider before anything is stored, and
 * that is the point of the shape: the account on the card is the one the service
 * says the token speaks for, never a name somebody typed. A service that is not
 * in here does not accept a token at all, and the form is not offered for it.
 */
const TOKEN_ACCOUNTS: Readonly<
    Record<
        string,
        (token: string) => Promise<{ accountId: string; label: string; avatarUrl?: string | null; email?: string | null }>
    >
> = {
    github: async (token) => {
        const account = await readGithubAccount(token);
        return {
            accountId: String(account.id),
            label: account.login,
            avatarUrl: account.avatarUrl,
            email: account.email
        };
    },
    vercel: async (token) => {
        const account = await vercelUser(token);
        return {
            accountId: account.id,
            label: account.username || account.name || account.email || "Vercel",
            email: account.email || null
        };
    },
    railway: async (token) => {
        const account = await railwayAccount(token);
        return {
            accountId: account.id,
            label: account.name || account.email || "Railway",
            email: account.email || null
        };
    }
};

/**
 * Link an account with a token instead of authorizing.
 *
 * Kept as an option for GitHub because a deployment whose operator has not
 * connected a GitHub App has no authorization screen to send anybody to, and it
 * is the only option for the two deployment services: what they issue is a token
 * for machines, and neither has a consent screen worth sending somebody to.
 */
export async function connectTokenAction(
    provider: string,
    rawToken: string
): Promise<{ error?: string; login?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    const readAccount = TOKEN_ACCOUNTS[provider];
    if (!readAccount) return { error: "That service cannot be connected with a token" };

    const parsed = tokenSchema.safeParse(rawToken);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Paste the token first" };

    try {
        const account = await readAccount(parsed.data);
        await saveConnection(user.id, {
            provider,
            accountId: account.accountId,
            label: account.label,
            avatarUrl: account.avatarUrl ?? null,
            method: "token",
            email: account.email ?? null,
            credential: { token: parsed.data }
        });
        revalidatePath(CONNECTIONS_PATH);
        return { login: account.label };
    } catch (caught) {
        if (caught instanceof ConnectionClaimedError || caught instanceof ConnectionLimitError) {
            return { error: caught.message };
        }
        return { error: caught instanceof Error ? caught.message : "Could not connect the account" };
    }
}

/** An AWS key pair and the region it was linked for. The region is asked for
 *  because a key is not regional and everything it reaches is. */
const awsSchema = z.object({
    accessKeyId: z.string().trim().min(16, "That does not look like an access key").max(128),
    secretAccessKey: z.string().trim().min(16, "That does not look like a secret key").max(256),
    region: z
        .string()
        .trim()
        .min(1, "Name the region your services are in")
        .max(32)
        .regex(/^[a-z0-9-]+$/, "A region looks like eu-west-1")
});

/**
 * Link an AWS account with an access key.
 *
 * Its own action rather than the token form, because AWS issues no token: a
 * request is signed with the secret, so what is stored is the key pair itself and
 * the region it was given for.
 *
 * Proved before it is stored, the same way every other link is. `GetCallerIdentity`
 * is the right check because AWS grants it to everybody - it needs no policy at
 * all - so it answers "is this key live" without depending on what the key is
 * allowed to do, which is a separate question the board asks later and answers in
 * that provider's own words.
 */
export async function connectAwsAction(input: unknown): Promise<{ error?: string; login?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    const parsed = awsSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };

    try {
        const identity = await awsIdentity(parsed.data);
        await saveConnection(user.id, {
            provider: "aws",
            // Their account number, which is what an AWS account is called and what
            // makes two links to the same one recognisably the same.
            accountId: identity.account,
            label: `${identity.arn.split("/").at(-1) || identity.account} (${parsed.data.region})`,
            method: "token",
            credential: {
                accessKeyId: parsed.data.accessKeyId,
                secretAccessKey: parsed.data.secretAccessKey,
                region: parsed.data.region
            }
        });
        revalidatePath(CONNECTIONS_PATH);
        return { login: identity.account };
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
