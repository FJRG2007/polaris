/**
 * What the booking, proposal, answer and room services share on the server:
 * refusing a form in the reader's words, holding back a caller who asks too
 * often, and minting the tokens their links carry.
 *
 * Server-only.
 */

import { calendarT } from "./i18n";
import { invalid } from "./outcome";
import { host } from "@polaris/app-host";
import { randomBytes } from "node:crypto";
import { CalendarRefusal } from "./errors";
import { issueKey } from "./scheduling-schemas";
import type { CalendarKey } from "../../messages";

/** A link token: 32 random bytes, unguessable and URL-safe. */
export function newLinkToken(): string {
    return randomBytes(24).toString("base64url");
}

/** A schema's refusal as an action's answer: our own key when it carries one,
 *  the engine's otherwise. */
export async function refusedInput(
    issues: readonly { message: string }[]
): Promise<{ ok: false; error: string }> {
    const key = issueKey(issues);
    if (key) return { ok: false, error: (await calendarT())(key as CalendarKey) };
    return invalid(issues);
}

/**
 * Count one request against `key` and refuse when it is over. Public pages call
 * this per address and per email, so one visitor cannot fill somebody's week or
 * send mail to a stranger in a loop.
 */
export async function throttle(key: string, limit: number, windowMs: number): Promise<void> {
    const result = await host.rateLimitService.rateLimit(key, limit, windowMs);
    if (!result.ok) throw new CalendarRefusal((await calendarT())("booking.slowDown"));
}

/** Emails one account may send to people outside Polaris in an hour, proposals
 *  and invitations together. */
const OUTSIDE_MAIL_PER_HOUR = 200;

/**
 * Count `count` emails to people outside Polaris against the account they go
 * out for, and answer whether they may go. A signed-in account types the
 * addresses, so without this it could mail strangers in a loop.
 */
export async function mayMailOutside(senderId: string, count = 1): Promise<boolean> {
    for (let sent = 0; sent < count; sent += 1) {
        const result = await host.rateLimitService.rateLimit(
            `calendar.mail-out:${senderId}`,
            OUTSIDE_MAIL_PER_HOUR,
            3_600_000
        );
        if (!result.ok) return false;
    }
    return true;
}

/** The caller's address for a rate limit; "unknown" when none can be read, so an
 *  unreadable address shares one bucket rather than escaping them all. */
export async function callerAddress(): Promise<string> {
    return (await host.requestContext.clientIp()) ?? "unknown";
}
