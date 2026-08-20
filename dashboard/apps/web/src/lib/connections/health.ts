/**
 * Whether the accounts somebody linked still work, asked before they need to.
 *
 * A token expires quietly. Nothing announces it, the screen that lists it keeps
 * saying the same login it always did, and the first sign is something else
 * failing for a reason that reads like anything but this: a deploy stopping at
 * the clone with git asking a terminal that does not exist for a username. That
 * is a whole afternoon of looking in the wrong place, and the answer was
 * knowable weeks earlier.
 *
 * So the links are asked, on a slow schedule, whether they still work. One
 * announcement per link when it stops - recorded on the row, so a sweep every
 * few hours is not a notification every few hours - and the record is cleared
 * the moment it answers again, so a renewed token is announced afresh if it ever
 * runs out a second time.
 *
 * Only GitHub for now, because GitHub is the only linked account Polaris does
 * unattended work with. The shape is per provider on purpose: the question "is
 * this credential still good" has a different answer for each of them and no
 * generic one.
 */

import { prisma } from "@polaris/db";
import { readCredential } from "./store";
import { notify } from "@/lib/notifications/dispatch";
import { readGithubAccount } from "@/lib/github-service";

/** Nothing here is urgent enough to be worth a long scan on a busy box. */
const BATCH = 200;

/** What a link is worth right now. */
export type LinkHealth = "working" | "expired" | "unknown";

/**
 * Ask GitHub whether this credential still speaks for anybody.
 *
 * Three answers rather than two, and the third is what stops this being a
 * nuisance: GitHub being unreachable, rate-limiting, or having a bad morning is
 * not somebody's token expiring, and announcing it as one would train them to
 * ignore the announcement that matters.
 */
export async function githubLinkHealth(token: string): Promise<LinkHealth> {
    try {
        await readGithubAccount(token);
        return "working";
    } catch (error) {
        const said = error instanceof Error ? error.message : "";
        return /unauthorized|401/i.test(said) ? "expired" : "unknown";
    }
}

/**
 * One pass over the linked GitHub accounts.
 *
 * Safe on every tick: it reads a small indexed set, asks one cheap question per
 * link, and says nothing at all on a deployment where every token is fine.
 */
export async function sweepConnectionHealth(): Promise<void> {
    const rows = await prisma.userConnection.findMany({
        where: { provider: "github" },
        select: { id: true, userId: true, label: true, method: true, healthNotice: true },
        take: BATCH
    });

    for (const row of rows) {
        const credential = await readCredential(row.id).catch(() => null);
        // A credential that cannot be read at all is its own kind of broken -
        // never stored, or undecryptable after a key rotation - and it is worth
        // the same sentence: the link no longer works and has to be made again.
        const token = credential?.token ?? credential?.accessToken ?? null;
        const health = token ? await githubLinkHealth(token) : "expired";
        await record(row, health);
    }
}

/**
 * Write what was found, and say it once.
 *
 * The announcement goes out before the row is written, so a failure to send is
 * retried on the next pass rather than being recorded as delivered - the same
 * order the provider-key sweep uses, and for the same reason.
 */
async function record(
    row: { id: string; userId: string; label: string; method: string; healthNotice: string },
    health: LinkHealth
): Promise<void> {
    if (health === "unknown") return;

    if (health === "expired" && row.healthNotice !== "expired") {
        await notify({
            userId: row.userId,
            event: "account.connection.expired",
            title: `Your GitHub account ${row.label} stopped working`,
            body:
                row.method === "token"
                    ? "The token you pasted has run out or been withdrawn. Until it is replaced, deploys from your private repositories will be refused."
                    : "GitHub no longer accepts that link. Until it is connected again, deploys from your private repositories will be refused.",
            href: "/account/connections"
        });
    }

    const notice = health === "expired" ? "expired" : "";
    if (notice === row.healthNotice) {
        await prisma.userConnection.update({ where: { id: row.id }, data: { checkedAt: new Date() } });
        return;
    }
    await prisma.userConnection.update({
        where: { id: row.id },
        data: { healthNotice: notice, checkedAt: new Date() }
    });
}

/**
 * Record what something else just found out.
 *
 * The sweep is not the only thing that learns a token has expired - a deploy
 * refused at the clone learns it first, and hours earlier. Telling this means
 * the announcement goes out then rather than at the next sweep, and that the
 * sweep does not repeat it.
 */
export async function noteConnectionRefused(userId: string, provider: string): Promise<void> {
    const rows = await prisma.userConnection.findMany({
        where: { userId, provider },
        select: { id: true, userId: true, label: true, method: true, healthNotice: true }
    });
    for (const row of rows) await record(row, "expired").catch(() => undefined);
}
