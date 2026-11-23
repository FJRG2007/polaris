/**
 * Reading and answering a sign-in request behind a short code, for a person
 * already signed in to Polaris: the approval screen's server actions
 * (`account/cli/actions.ts`) and Polaris Desktop answering for Polaris
 * Terminal on the same computer (`/api/terminal/authorize/describe|answer`)
 * both go through here, so neither can skip the throttle, the new-device
 * gate, the scope narrowing or the audit.
 */

import { z } from "zod";
import type { SessionUser } from "@/lib/session";
import { readUserCode } from "@/lib/device-code";
import { scopesAvailableTo } from "@polaris/auth";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { getTranslations } from "@/lib/i18n/request";
import { newDeviceRefusal } from "@/lib/device-grace";
import { localized } from "@/app/(app)/account/security/action-messages";
import {
    answerCliSignIn,
    describeCliSignIn,
    type PendingCliSignIn,
    type SignInKind
} from "@/lib/cli/sign-in";

/** Guess-throttling for the short code, which is what stands between a
 *  stranger's request and somebody's account. */
const LOOKUP_LIMIT = 20;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;

/** Which screen is asking: the CLI's or the Stream Deck's. Each finds only its
 *  own kind of request. */
const kindSchema = z.enum(["cli", "streamdeck", "tv", "terminal"]).default("cli");

const answerSchema = z.object({
    userCode: z.string().min(1).max(32),
    approve: z.boolean(),
    kind: kindSchema
});

/**
 * The request behind a code, throttled. Every path that turns a typed code into
 * somebody's pending request goes through here, so none of them can skip the
 * guard. Unknown, expired and already answered are one answer.
 */
async function lookup(
    userId: string,
    typed: unknown,
    kind: SignInKind
): Promise<{ code?: string; pending?: PendingCliSignIn; error?: string }> {
    // One budget for both screens: they guess at the same codes.
    const throttle = await rateLimit(`cli-code:${userId}`, LOOKUP_LIMIT, LOOKUP_WINDOW_MS);
    const t = await getTranslations("account");
    if (!throttle.ok) return { error: t(`${kind}.errors.tooMany`) };

    const code = typeof typed === "string" ? readUserCode(typed) : null;
    if (!code) return { error: t(`${kind}.errors.notACode`) };
    const pending = await describeCliSignIn(code, new Date(), kind);
    if (!pending) return { error: t(`${kind}.errors.nothingWaiting`) };
    return { code, pending };
}

/**
 * The request behind a code, for the screen that shows it - with the scopes cut
 * to what this account holds, so the screen lists what the key will really be
 * able to do rather than what the CLI asked for.
 */
export async function describeSignInFor(
    user: SessionUser,
    typed: unknown,
    askedKind?: unknown
): Promise<{ pending?: PendingCliSignIn; error?: string }> {
    const kind = kindSchema.catch("cli").parse(askedKind);
    const found = await lookup(user.id, typed, kind);
    if (found.error || !found.pending) return { error: found.error };
    if (kind === "tv") return { pending: found.pending };
    const held = new Set<string>(await scopesAvailableTo(user.id, user.isAdmin));
    const scopes = found.pending.scopes.filter((scope) => held.has(scope));
    if (scopes.length === 0)
        return { error: (await getTranslations("account"))(`${kind}.errors.noScopes`) };
    return { pending: { ...found.pending, scopes } };
}

/** Sign it in, or turn it away. */
export async function answerSignInFor(
    user: SessionUser,
    input: unknown
): Promise<{ ok?: true; error?: string }> {
    // A browser that has only just signed in does not get to hand a standing
    // credential to a terminal while the account is still deciding whether it is
    // the owner's - the same gate the extension's approval passes.
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });

    const t = await getTranslations("account");
    const parsed = answerSchema.safeParse(input);
    if (!parsed.success) return { error: t("cli.errors.cannotAnswer") };
    const kind = parsed.data.kind;

    const found = await lookup(user.id, parsed.data.userCode, kind);
    if (found.error || !found.code || !found.pending)
        return { error: found.error ?? t(`${kind}.errors.cannotAnswer`) };
    const { code, pending } = found;

    const answered = await answerCliSignIn({
        userId: user.id,
        userCode: code,
        approve: parsed.data.approve,
        kind
    });
    if (!answered) return { error: t(`${kind}.errors.nothingWaiting`) };

    await recordAudit({
        actorId: user.id,
        action: `account.${kind}.${parsed.data.approve ? "approved" : "refused"}`,
        targetType: kind,
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
