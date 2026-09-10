/**
 * A mailbox whose server stopped accepting its credential.
 *
 * What a desktop client does when somebody changes their password somewhere
 * else: it stops trying the old one, says so once, and asks for the new one. The
 * three halves of that live here.
 *
 * - **Stop.** The row moves to `auth`, and every pass after that waits out the
 *   backoff in `refusals.ts` instead of logging in again on the next tick.
 * - **Say so once.** The owner is told the moment the row moves, and only then:
 *   the conditional update is the lock, so a mailbox refused on every retry for
 *   a week is one notification, and two passes landing together are still one.
 * - **Pick up again.** A pass that works puts the row back to `ok`
 *   (`recordAccountState`), and the next refusal after that is news again.
 */

import { prisma } from "@polaris/db";
import { refusedMailboxHref } from "./refusals";

/**
 * Write down that the server refused this mailbox, and tell its owner if that
 * is news.
 *
 * `lastSyncAt` moves on every refusal, which is what spaces the next try out.
 * The detail is the sentence the refusal already carried - Polaris' own words,
 * never the server's, which name hosts and paths.
 */
export async function recordCredentialRefusal(accountId: string, detail: string): Promise<void> {
    const now = new Date();
    const moved = await prisma.mailAccount.updateMany({
        where: { id: accountId, state: { not: "auth" } },
        data: { state: "auth", stateDetail: detail, lastSyncAt: now }
    });
    if (moved.count === 0) {
        // Already refused and already announced. Only the clock moves.
        await prisma.mailAccount.updateMany({
            where: { id: accountId },
            data: { stateDetail: detail, lastSyncAt: now }
        });
        return;
    }

    const account = await prisma.mailAccount.findUnique({
        where: { id: accountId },
        select: { userId: true, address: true, auth: true }
    });
    if (!account) return;
    const authorized = account.auth === "oauth";
    try {
        // Reached only on the one call that announces something. The sync and
        // the send queue both record refusals through here, and neither should
        // drag the whole notification fan-out - mail, webhooks, texts - into
        // everything that imports them.
        const { notify } = await import("@/lib/notifications/dispatch");
        await notify({
            userId: account.userId,
            event: "mail.account.refused",
            title: authorized
                ? `${account.address} needs connecting again`
                : `${account.address} stopped accepting its password`,
            body: authorized
                ? "Its authorization was refused or withdrawn, so Polaris paused checking it. Reconnect it in Mail to start again."
                : "If you changed it recently, update it in Mail. Polaris paused checking this mailbox so the server does not lock it for repeated failed sign-ins.",
            href: refusedMailboxHref(accountId),
            actionRequired: true,
            metadata: { accountId }
        });
    } catch (caught) {
        // The row already says it, and the rail and the list draw that. A bell
        // that could not be written is not worth failing the pass over.
        console.error("polaris: a refused mailbox could not be announced:", caught);
    }
}

/**
 * Try every refused mailbox an authorization covers, now.
 *
 * Called when somebody authorizes an outside account again. Re-authorizing the
 * same account refreshes its link in place, so the mailboxes pointing at it can
 * work the moment it lands - and waiting out a backoff of up to a day to find
 * that out would be the screen saying "reconnect" to somebody who just did.
 */
export async function retryRefusedMailboxes(connectionId: string): Promise<void> {
    const rows = await prisma.mailAccount.findMany({
        where: { connectionId, state: "auth" },
        select: { id: true }
    });
    if (rows.length === 0) return;
    // Reached when needed rather than at the top: the sync records its refusals
    // through this file, so a static import each way would be a cycle.
    const { syncAccount } = await import("./sync");
    for (const row of rows) await syncAccount(row.id, { force: true }).catch(() => undefined);
}
