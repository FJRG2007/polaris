"use server";

/**
 * Reading and answering a client's request to be let into this vault.
 *
 * Both of these require an account with `vault.use`, and approving requires the
 * caller to have produced a key sealed to the request's public half - which they
 * can only do with an unlocked vault, since Polaris does not hold anything that
 * could seal it. So the permission check here is the outer gate and the sealed key
 * is the real one: a session alone cannot approve anything.
 */

import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { readUserCode, type PendingAuthorization } from "@/lib/vault/authorization-code";
import { answerVaultAuthorization, describeVaultAuthorization } from "@/lib/vault/authorization";

/** What the log keeps about a client that was let in, or turned away. */
const LET_IN = "vault.client.authorized";
const TURNED_AWAY = "vault.client.refused";

const answerSchema = z.object({
    userCode: z.string().min(1).max(32),
    approve: z.boolean(),
    /** The account's vault key, sealed to the request's public half. Capped because
     *  it is a fixed-size ciphertext and this column is not a scratchpad. */
    wrappedKey: z.string().min(1).max(4096).optional()
});

/**
 * The request behind a code, or null.
 *
 * One answer for unknown, expired, already answered and claimed by somebody else:
 * the code is short enough to guess at, and four different answers would tell a
 * guesser which guesses were close.
 */
export async function describeAuthorizationAction(
    typed: unknown
): Promise<{ pending?: PendingAuthorization; error?: string }> {
    await requirePermission("vault.use");
    const code = typeof typed === "string" ? readUserCode(typed) : null;
    if (!code) return { error: "That is not a code from a Polaris app." };
    const pending = await describeVaultAuthorization(code);
    if (!pending) {
        return { error: "Nothing is waiting on that code. Ask the app for a new one." };
    }
    return { pending };
}

/** Let it in, or turn it away. */
export async function answerAuthorizationAction(
    input: unknown
): Promise<{ ok?: true; error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = answerSchema.safeParse(input);
    if (!parsed.success) return { error: "That request cannot be answered." };

    const code = readUserCode(parsed.data.userCode);
    if (!code) return { error: "That is not a code from a Polaris app." };

    // Read before answering, so what the log records is what the person saw rather
    // than what a row said after it was spent.
    const pending = await describeVaultAuthorization(code);
    if (!pending) {
        return { error: "Nothing is waiting on that code. Ask the app for a new one." };
    }

    const answered = await answerVaultAuthorization({
        userId: user.id,
        userCode: code,
        approve: parsed.data.approve,
        wrappedKey: parsed.data.wrappedKey
    });
    if (answered.error) return { error: answered.error };

    await recordAudit({
        actorId: user.id,
        action: parsed.data.approve ? LET_IN : TURNED_AWAY,
        targetType: "vault-authorization",
        targetId: code,
        metadata: {
            device: pending.device,
            origin: pending.requestIp,
            host: pending.host
        }
    });
    return { ok: true };
}
