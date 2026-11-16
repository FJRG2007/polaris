/**
 * A subscription login stored as a model key.
 *
 * A login (SuperGrok, GitHub Copilot) is kept in the same encrypted row a pasted
 * key is, on the provider's own slug, so it is named, ordered, limited and
 * removed like any other key. What differs is the secret: instead of a key it
 * is this JSON, holding the access token, the token that renews it, when it
 * stops working and whatever the provider told us at sign-in (an API address,
 * an instance). Only the access token ever leaves this module.
 *
 * Pure: the refresh itself is `provider-logins.ts`.
 */

import { z } from "zod";
import { cloudHintSource, readCloudSecret } from "@/lib/agents/cloud-credentials";

const storedSchema = z.object({
    kind: z.literal("oauth"),
    access: z.string().min(1),
    /** Empty for a login whose access token does not expire (Copilot). */
    refresh: z.string(),
    /** Epoch milliseconds; 0 for a token with no end. */
    expires: z.number().nonnegative(),
    metadata: z.record(z.string(), z.string()).optional()
});

export type StoredOAuth = z.infer<typeof storedSchema>;

/** The stored login a secret holds, or null for a plain key. A key cannot start
 *  with `{`, so a key is never mistaken for a login. */
export function readOAuthSecret(secret: string): StoredOAuth | null {
    if (!secret.startsWith("{")) return null;
    try {
        const parsed = storedSchema.safeParse(JSON.parse(secret));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** The secret a login is stored as. */
export function writeOAuthSecret(login: Omit<StoredOAuth, "kind">): string {
    return JSON.stringify({ kind: "oauth", ...login });
}

/** What the key hint and anything handed to a run reads: the access token for a
 *  login, the value naming a cloud account (`cloudHintSource`), the secret
 *  itself for a key. */
export function spendableSecret(secret: string): string {
    const cloud = readCloudSecret(secret);
    if (cloud) return cloudHintSource(cloud);
    return readOAuthSecret(secret)?.access ?? secret;
}

/** Whether a login has to be renewed before its token is used: within five
 *  minutes of its end, as OpenCode's providers do. */
export function oauthNeedsRefresh(login: StoredOAuth, now: number): boolean {
    return login.expires > 0 && login.refresh !== "" && login.expires - now < 5 * 60_000;
}
