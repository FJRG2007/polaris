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
 * Only GitHub for the credential question, because GitHub is the only linked
 * account Polaris does unattended work with. The shape is per provider on
 * purpose: the question "is this credential still good" has a different answer
 * for each of them and no generic one.
 *
 * The second question here IS generic, and costs no network call at all: whether
 * a link still carries the scopes this deployment asks for. A consent screen
 * grows - `guilds` was added to Discord's after people had linked - and every
 * grant made before it carries the narrower set. Nothing breaks and nothing
 * announces it; the feature built on the new scope simply returns nothing, which
 * reads as the feature being broken rather than as a consent nobody was asked
 * for. So the grants are measured against what is asked for now, and whoever has
 * to approve it is the one told.
 */

import { prisma } from "@polaris/db";
import { readCredential } from "./store";
import { findConnectionProvider } from "@polaris/core";
import { notify } from "@/lib/notifications/dispatch";
import { readGithubAccount } from "@/lib/github-service";
import { linkScopesSatisfied, missingLinkScopes } from "./oauth";

/** Nothing here is urgent enough to be worth a long scan on a busy box. */
const BATCH = 200;

/**
 * What a link is worth right now.
 *
 * `stale-scopes` is not a broken link: the credential works and everything it
 * could do yesterday it can still do. What it cannot do is the thing the wider
 * consent was added for, and only its owner can fix that.
 */
export type LinkHealth = "working" | "expired" | "unknown" | "stale-scopes";

/** What is written on the row once its owner has been told, so a sweep every few
 *  hours is not a notification every few hours. */
type HealthNotice = "" | "expired" | "scopes";

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

    await sweepLinkScopes();
}

/**
 * One pass over every authorized link, asking whether it still carries what this
 * deployment now requires.
 *
 * No network call: the grant is on the row, and what is required is in the
 * adapter table. That is what makes it safe to run over every provider rather
 * than the one Polaris does unattended work with.
 *
 * Only `oauth` links. A pasted token was never granted through a consent screen,
 * so it has no scopes to have fallen behind and asking its owner to re-authorize
 * would be asking them to repeat something they never did.
 */
export async function sweepLinkScopes(): Promise<void> {
    const rows = await prisma.userConnection.findMany({
        where: { method: "oauth" },
        select: { id: true, userId: true, provider: true, label: true, method: true, scope: true, healthNotice: true },
        take: BATCH
    });

    for (const row of rows) {
        // An expired link is the worse of the two and already says "link it
        // again", which is the same action. Telling somebody twice about one
        // account, for two reasons, is how a notification stops being read.
        if (row.healthNotice === "expired") continue;
        const satisfied = linkScopesSatisfied(row.provider, row.scope);
        await record(row, satisfied ? "working" : "stale-scopes").catch(() => undefined);
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
    row: {
        id: string;
        userId: string;
        label: string;
        method: string;
        healthNotice: string;
        provider?: string;
        scope?: string;
    },
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

    if (health === "stale-scopes" && row.healthNotice !== "scopes") {
        const name = findConnectionProvider(row.provider ?? "")?.name ?? row.provider ?? "That service";
        // Named rather than counted. "Polaris needs one more permission" tells
        // somebody nothing about whether to grant it, and this is a consent -
        // the whole point is that they get to decide with the facts.
        const missing = missingLinkScopes(row.provider ?? "", row.scope ?? "");
        await notify({
            userId: row.userId,
            event: "account.connection.scopes",
            title: `Connect ${name} again to finish setting it up`,
            body: `Polaris now asks ${name} for ${listed(missing)}, which your account ${row.label} was not linked with. Nothing you have has stopped working - connecting it again is what grants the new part.`,
            href: "/account/connections"
        });
    }

    const notice: HealthNotice = health === "expired" ? "expired" : health === "stale-scopes" ? "scopes" : "";
    if (notice === row.healthNotice) {
        await prisma.userConnection.update({ where: { id: row.id }, data: { checkedAt: new Date() } });
        return;
    }
    await prisma.userConnection.update({
        where: { id: row.id },
        data: { healthNotice: notice, checkedAt: new Date() }
    });
}

/** The missing permissions as a person would read them out, rather than a JSON
 *  array printed into a sentence. */
function listed(scopes: string[]): string {
    if (scopes.length === 0) return "more than it used to";
    if (scopes.length === 1) return `one more permission (${scopes[0]})`;
    return `${scopes.length} more permissions (${scopes.slice(0, -1).join(", ")} and ${scopes[scopes.length - 1]})`;
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
