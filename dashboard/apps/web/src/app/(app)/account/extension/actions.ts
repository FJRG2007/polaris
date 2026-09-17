"use server";

/**
 * Reading and answering a browser extension's request to be connected.
 *
 * Both require a signed-in account, and that is the whole of what approving one
 * proves - which is the point of the flow: the extension holds nothing until
 * somebody who is already inside Polaris says so, in a browser Polaris can see.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { readUserCode } from "@/lib/device-code";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { newDeviceRefusal } from "@/lib/device-grace";
import {
    answerExtensionConnection,
    describeExtensionConnection,
    type PendingConnection
} from "@/lib/extension/sessions";

const LET_IN = "account.extension.connected";
const TURNED_AWAY = "account.extension.refused";

/** Guess-throttling for the short code, which is what stands between a stranger's
 *  request and somebody's account. */
const LOOKUP_LIMIT = 20;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;

const answerSchema = z.object({ userCode: z.string().min(1).max(32), approve: z.boolean() });

/**
 * The request behind a code, or null.
 *
 * One answer for unknown, expired and already answered: the code is short enough
 * to guess at, and three different answers would tell a guesser which guesses
 * were close.
 */
export async function describeConnectionAction(
    typed: unknown
): Promise<{ pending?: PendingConnection; error?: string }> {
    const user = await requireUser();
    const throttle = await rateLimit(`extension-code:${user.id}`, LOOKUP_LIMIT, LOOKUP_WINDOW_MS);
    if (!throttle.ok) return { error: "Too many codes tried. Wait a few minutes." };

    const code = typeof typed === "string" ? readUserCode(typed) : null;
    if (!code) return { error: "That is not a code from the Polaris extension." };
    const pending = await describeExtensionConnection(code);
    if (!pending) {
        return { error: "Nothing is waiting on that code. Ask the extension for a new one." };
    }
    return { pending };
}

/** Connect it, or turn it away. */
export async function answerConnectionAction(input: unknown): Promise<{ ok?: true; error?: string }> {
    const user = await requireUser();
    // A browser that has just signed in for the first time does not get to hand
    // a standing credential to an extension while the account is still deciding
    // whether it is the owner's - the same gate the other device actions pass.
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    const parsed = answerSchema.safeParse(input);
    if (!parsed.success) return { error: "That request cannot be answered." };
    const code = readUserCode(parsed.data.userCode);
    if (!code) return { error: "That is not a code from the Polaris extension." };

    // Read before answering, so what the log records is what the person saw.
    const pending = await describeExtensionConnection(code);
    if (!pending) {
        return { error: "Nothing is waiting on that code. Ask the extension for a new one." };
    }

    const answered = await answerExtensionConnection({
        userId: user.id,
        userCode: code,
        approve: parsed.data.approve,
        sessionId: user.sessionId
    });
    if (answered.error) return { error: answered.error };

    await recordAudit({
        actorId: user.id,
        action: parsed.data.approve ? LET_IN : TURNED_AWAY,
        targetType: "extension",
        targetId: pending.device,
        metadata: { browser: pending.browser, os: pending.os, ip: pending.requestIp }
    });
    return { ok: true };
}
