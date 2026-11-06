"use server";

/**
 * A meeting's join code, typed at /m.
 *
 * The code leads to the meeting's guest link and nowhere else, so whoever types
 * one meets every rule the link already has - its password, its address limits,
 * accounts only, and the lobby when the host lets people in themselves.
 *
 * Answers the same way for a code that names nothing, one whose meeting ended
 * and one whose link was shut, so the form cannot be used to find out which
 * codes are real. Every try counts against the address it came from.
 */

import { getTranslations } from "@/lib/i18n/request";
import { guestTokenForJoinCode } from "@/lib/chat/meetings";
import { clientIp, hashForLog } from "@/lib/request-context";
import { joinCodeInputSchema } from "@/lib/chat/meeting-invites";
import { rateLimit } from "@/lib/rate-limit-service";

/** Codes one address may try per window. */
const JOIN_CODE_LIMIT = 10;
const JOIN_CODE_WINDOW_MS = 10 * 60_000;

export async function joinWithCodeAction(typed: unknown): Promise<{ to?: string; error?: string }> {
    const t = await getTranslations("chat");
    const limitKey = `meeting-code:${hashForLog(await clientIp()) ?? "unknown"}`;
    // Counted before the code is even read, so a malformed guess is a guess too.
    if (!(await rateLimit(limitKey, JOIN_CODE_LIMIT, JOIN_CODE_WINDOW_MS)).ok) {
        return { error: t("meetingCode.tooMany") };
    }

    const parsed = joinCodeInputSchema.safeParse(typeof typed === "string" ? typed : "");
    if (!parsed.success || !parsed.data) return { error: t("meetingCode.notFound") };

    const token = await guestTokenForJoinCode(parsed.data);
    if (!token) return { error: t("meetingCode.notFound") };

    // Not reset on a success: one real code would otherwise be a way to clear
    // the count between guesses at others.
    return { to: `/m/${token}` };
}
