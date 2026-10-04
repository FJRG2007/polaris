"use server";

/**
 * Reading and answering a command-line client's request to be signed in.
 *
 * Both require a signed-in account, which is the whole of what approving one
 * proves: the CLI holds nothing until somebody already inside Polaris says so,
 * in a browser Polaris can see. Modelled on the extension's own
 * (`account/extension/actions.ts`), throttle and audit included.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { readUserCode } from "@/lib/device-code";
import { scopesAvailableTo } from "@polaris/auth";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { getTranslations } from "@/lib/i18n/request";
import { newDeviceRefusal } from "@/lib/device-grace";
import { localized } from "../security/action-messages";
import { answerCliSignIn, describeCliSignIn, type PendingCliSignIn } from "@/lib/cli/sign-in";

/** Guess-throttling for the short code, which is what stands between a
 *  stranger's request and somebody's account. */
const LOOKUP_LIMIT = 20;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;

const answerSchema = z.object({ userCode: z.string().min(1).max(32), approve: z.boolean() });

/**
 * The request behind a code, throttled. Every path that turns a typed code into
 * somebody's pending request goes through here, so none of them can skip the
 * guard. Unknown, expired and already answered are one answer.
 */
async function lookup(
    userId: string,
    typed: unknown
): Promise<{ code?: string; pending?: PendingCliSignIn; error?: string }> {
    const throttle = await rateLimit(`cli-code:${userId}`, LOOKUP_LIMIT, LOOKUP_WINDOW_MS);
    const t = await getTranslations("account");
    if (!throttle.ok) return { error: t("cli.errors.tooMany") };

    const code = typeof typed === "string" ? readUserCode(typed) : null;
    if (!code) return { error: t("cli.errors.notACode") };
    const pending = await describeCliSignIn(code);
    if (!pending) return { error: t("cli.errors.nothingWaiting") };
    return { code, pending };
}

/**
 * The request behind a code, for the screen that shows it - with the scopes cut
 * to what this account holds, so the screen lists what the key will really be
 * able to do rather than what the CLI asked for.
 */
export async function describeCliSignInAction(
    typed: unknown
): Promise<{ pending?: PendingCliSignIn; error?: string }> {
    const user = await requireUser();
    const found = await lookup(user.id, typed);
    if (found.error || !found.pending) return { error: found.error };
    const held = new Set<string>(await scopesAvailableTo(user.id, user.isAdmin));
    const scopes = found.pending.scopes.filter((scope) => held.has(scope));
    if (scopes.length === 0)
        return { error: (await getTranslations("account"))("cli.errors.noScopes") };
    return { pending: { ...found.pending, scopes } };
}

/** Sign it in, or turn it away. */
export async function answerCliSignInAction(
    input: unknown
): Promise<{ ok?: true; error?: string }> {
    const user = await requireUser();
    // A browser that has only just signed in does not get to hand a standing
    // credential to a terminal while the account is still deciding whether it is
    // the owner's - the same gate the extension's approval passes.
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });

    const t = await getTranslations("account");
    const parsed = answerSchema.safeParse(input);
    if (!parsed.success) return { error: t("cli.errors.cannotAnswer") };

    const found = await lookup(user.id, parsed.data.userCode);
    if (found.error || !found.code || !found.pending)
        return { error: found.error ?? t("cli.errors.cannotAnswer") };
    const { code, pending } = found;

    const answered = await answerCliSignIn({
        userId: user.id,
        userCode: code,
        approve: parsed.data.approve
    });
    if (!answered) return { error: t("cli.errors.nothingWaiting") };

    await recordAudit({
        actorId: user.id,
        action: parsed.data.approve ? "account.cli.approved" : "account.cli.refused",
        targetType: "cli",
        // The code rather than the name, which is the CLI's own unverified claim.
        targetId: code,
        metadata: {
            device: pending.device,
            os: pending.os,
            version: pending.clientVersion,
            ip: pending.requestIp,
            scopes: pending.scopes.join(",")
        }
    });
    return { ok: true };
}
