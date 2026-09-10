/**
 * Whether the Mail server app is here, and the rules for adding and removing it.
 *
 * The mail server is a marketplace app: until somebody installs it, its screens
 * are not in the navigation, its routes offer the install instead of a list, and
 * the background pass over mail servers does nothing. Installing it runs nothing
 * either - the engine is pulled onto a machine only when a server is set up from
 * inside the app.
 *
 * One install for the whole Polaris, like Places: what it gates is read
 * instance-wide, so which administrator happened to install it decides nothing
 * about who sees it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { findApp } from "@/lib/apps/catalog";
import { invalidateInstallPresence, isAppInstalled } from "@/lib/apps/install-presence";

/** The catalog id, written in the manifest, in the navigation entry and here.
 *  `test/mail-server/app-install.test.ts` holds the three to the same string. */
export const MAIL_SERVER_APP = "mail-server";

/** A refusal written for the person who asked, shown where they asked. */
export class MailServerAppRefusal extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "MailServerAppRefusal";
    }
}

/** Whether the app is installed - explicitly, or by a mail server already
 *  existing (see `install-presence`). Cached for a few seconds. */
export function mailServerAppInstalled(): Promise<boolean> {
    return isAppInstalled(MAIL_SERVER_APP);
}

/**
 * The install row, adopting one for an instance that ran a mail server before
 * the app was installable. Null when it has never been installed.
 *
 * The adopted row names whoever set the first server up, so the one person who
 * certainly chose to run mail here is the one it is recorded against.
 * Idempotent, and cheap enough to run whenever one of the app's screens opens,
 * which is how it reaches an instance whose operator never opens the
 * marketplace.
 */
export async function adoptMailServerApp(): Promise<string | null> {
    const existing = await currentInstall(prisma);
    if (existing) return existing;
    const first = await prisma.mailServer.findFirst({ orderBy: { createdAt: "asc" }, select: { ownerId: true } });
    if (!first) return null;
    const adopted = await prisma.$transaction(async (tx) => {
        if (loadEnv().POLARIS_DB_PROVIDER === "postgresql") {
            await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('polaris.mail-server.adopt'))");
        }
        const raced = await currentInstall(tx);
        if (raced) return { id: raced, created: false };
        const created = await tx.installedApp.create({
            data: {
                catalogId: MAIL_SERVER_APP,
                ownerId: first.ownerId,
                name: findApp(MAIL_SERVER_APP)?.name ?? "Mail server",
                status: "running",
                installedById: first.ownerId
            },
            select: { id: true }
        });
        return { id: created.id, created: true };
    });
    if (adopted.created) invalidateInstallPresence(MAIL_SERVER_APP);
    return adopted.id;
}

/** The oldest live install row, or null. */
async function currentInstall(
    client: Pick<typeof prisma, "installedApp">
): Promise<string | null> {
    const row = await client.installedApp.findFirst({
        where: { catalogId: MAIL_SERVER_APP, status: { not: "removed" } },
        orderBy: { createdAt: "asc" },
        select: { id: true }
    });
    return row?.id ?? null;
}

/**
 * Why the app cannot be uninstalled right now, or null when it can.
 *
 * A mail server that is set up is receiving somebody's mail, and uninstalling
 * the app would take away the only screens that manage it while leaving the
 * server running. So every one of them has to be removed first - which is a
 * decision about the mail, made on the server's own page.
 */
export async function uninstallRefusal(): Promise<string | null> {
    const servers = await prisma.mailServer.count();
    if (servers === 0) return null;
    return servers === 1
        ? "A mail server is still set up here. Remove it first, then uninstall Mail server."
        : `${servers} mail servers are still set up here. Remove them first, then uninstall Mail server.`;
}

/**
 * Uninstall the app for the whole Polaris.
 *
 * Refused while a mail server exists, and left to whoever installed it or an
 * administrator - the same rule as removing any other install. Every install row
 * goes, so a second copy made before installs were one per Polaris cannot keep
 * the screens alive. Runs nothing down: installing started nothing.
 */
export async function uninstallMailServerApp(actor: { id: string; isAdmin: boolean }): Promise<string[]> {
    const refusal = await uninstallRefusal();
    if (refusal) throw new MailServerAppRefusal(refusal);
    const rows = await prisma.installedApp.findMany({
        where: { catalogId: MAIL_SERVER_APP, status: { not: "removed" } },
        select: { id: true, ownerId: true }
    });
    if (rows.length === 0) throw new MailServerAppRefusal("Mail server is not installed.");
    if (!actor.isAdmin && !rows.some((row) => row.ownerId === actor.id)) {
        throw new MailServerAppRefusal("Only whoever installed Mail server, or an administrator, can uninstall it.");
    }
    const ids = rows.map((row) => row.id);
    // Marked removed rather than deleted, like every other uninstall here.
    await prisma.installedApp.updateMany({ where: { id: { in: ids } }, data: { status: "removed" } });
    invalidateInstallPresence(MAIL_SERVER_APP);
    return ids;
}
