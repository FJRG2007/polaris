/**
 * A session's agent refused by its provider: the sign-in or key it was handed
 * is no longer accepted.
 *
 * The turn records what the tool said ("Failed to authenticate. API Error: 401
 * Invalid bearer token"), which tells nobody that the fix is linking the
 * account again, or where. This reads that failure, marks the stored account
 * refused the way Polar's router marks a refused key (so the keys screen and
 * the agent picker say so), and names it for the session's notice.
 *
 * Server-only apart from the pure readers.
 */

import { prisma } from "@polaris/db";
import { COOLING_MS } from "@/lib/polar/router/health";

/**
 * What each tool prints when its credential is refused. Claude Code's
 * StopFailure hook names the error `authentication_failed`; the rest are the
 * sentences the tools themselves print (Claude Code, Codex, Gemini CLI,
 * Copilot) and Anthropic's and OpenAI's own error bodies. A bare 401 is not
 * one: a line number or a port can be 401 too.
 */
const REFUSALS: readonly RegExp[] = [
    /authentication_failed/i,
    /failed to authenticate/i,
    /authentication failed/i,
    /invalid bearer token/i,
    /oauth token (has expired|has been revoked|revoked|is invalid)/i,
    /invalid x-api-key/i,
    /invalid api key/i,
    /incorrect api key/i,
    /api key not valid/i,
    /authentication_error/i,
    /api error: 401\b/i,
    /\b401 unauthorized\b/i,
    /status(?: code)? 401\b/i
];

/** Whether a failed turn's text is the provider refusing the credential. Pure. */
export function isSignInRefusal(text: string | null | undefined): boolean {
    if (!text) return false;
    return REFUSALS.some((pattern) => pattern.test(text));
}

/**
 * Whether the session's latest turn ended on a refused credential: the last
 * turn that finished, failed on one. A turn that worked after it clears it.
 * Events in the order they happened. Pure.
 */
export function lastTurnRefused(
    events: readonly { kind: string; detail: string }[]
): boolean {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]!;
        if (event.kind === "turn.end") return false;
        if (event.kind === "turn.failed") return isSignInRefusal(event.detail);
    }
    return false;
}

/**
 * Mark the account a session signs in with as refused, the same way the router
 * cools a key its provider refused (`noteRefusal`): out for `COOLING_MS.key`,
 * reason `key`, which every key screen reads as "Refused" and its owner can
 * put back at once. Nothing for a session that picked no account: which of the
 * stored ones the tool used is not known here. Best-effort.
 */
export async function noteRefusedSignIn(sessionId: string, now = Date.now()): Promise<void> {
    try {
        const session = await prisma.agentSession.findUnique({
            where: { id: sessionId },
            select: { accountId: true }
        });
        if (!session?.accountId) return;
        await prisma.userModelKey.updateMany({
            where: { id: session.accountId },
            data: { coolingUntil: new Date(now + COOLING_MS.key), coolingReason: "key" }
        });
    } catch (error) {
        console.error(
            `[agent-session] ${sessionId}: could not mark its sign-in refused:`,
            error instanceof Error ? error.message : "unknown"
        );
    }
}

/**
 * What to call the account a session signs in with: the address its sign-in
 * gave, else the name its owner chose. Null when the session picked none, or
 * the account is gone.
 */
export async function refusedAccountName(accountId: string | null): Promise<string | null> {
    if (!accountId) return null;
    const row = await prisma.userModelKey
        .findUnique({ where: { id: accountId }, select: { name: true, config: true } })
        .catch(() => null);
    if (!row) return null;
    let email: unknown = null;
    try {
        email = (JSON.parse(row.config) as { email?: unknown }).email;
    } catch {
        email = null;
    }
    return typeof email === "string" && email ? email : row.name;
}
