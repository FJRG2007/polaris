/**
 * Who may keep one status page up to date.
 *
 * Whoever holds `status.manage` runs every page, as before. Somebody one of
 * them shared a page with (`status.page`, `edit`) runs that page and nothing
 * else: its components, checks, incidents, maintenance, title and address.
 * Creating and deleting pages, custom domains and the list of deployed
 * addresses stay with `status.manage`.
 *
 * An action names what it touches; every page those things belong to must be
 * one the caller may edit, so moving a component or a check onto another page
 * needs that page too. Server-only.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";
import { settle, StatusRefusal, type Outcome } from "./outcome";

/** One thing an action touches, by what it is. */
export type PageTarget =
    | { readonly page: string }
    | { readonly slug: string }
    | { readonly components: readonly string[] }
    | { readonly check: string }
    | { readonly incident: string }
    | { readonly maintenance: string };

/** The pages a set of targets belong to. A target that names nothing that
 *  exists yields null, which nobody but a manager passes. */
export async function pagesOf(targets: readonly PageTarget[]): Promise<(string | null)[]> {
    return Promise.all(targets.map(pageIdsOf)).then((all) => all.flat());
}

async function pageIdsOf(target: PageTarget): Promise<(string | null)[]> {
    if ("page" in target) return [target.page];
    if ("slug" in target) {
        const page = await prisma.statusPage.findUnique({
            where: { slug: target.slug },
            select: { id: true }
        });
        return [page?.id ?? null];
    }
    if ("components" in target) {
        if (target.components.length === 0) return [];
        const rows = await prisma.statusComponent.findMany({
            where: { id: { in: [...target.components] } },
            select: { pageId: true }
        });
        // One that does not exist is refused rather than skipped.
        if (rows.length < new Set(target.components).size) return [null];
        return [...new Set(rows.map((row) => row.pageId))];
    }
    if ("check" in target) {
        const check = await prisma.statusCheck.findUnique({
            where: { id: target.check },
            select: { component: { select: { pageId: true } } }
        });
        return [check?.component.pageId ?? null];
    }
    if ("incident" in target) {
        const incident = await prisma.statusIncident.findUnique({
            where: { id: target.incident },
            select: { pageId: true }
        });
        return [incident?.pageId ?? null];
    }
    const maintenance = await prisma.statusMaintenance.findUnique({
        where: { id: target.maintenance },
        select: { pageId: true }
    });
    return [maintenance?.pageId ?? null];
}

/** The pages shared with this account to edit. */
export async function editablePageIds(userId: string): Promise<string[]> {
    const held = await host.accessGrants.grantedSubjects(userId, "status.page");
    return [...held]
        .filter(([, capability]) => core.atLeast("status.page", capability, "edit"))
        .map(([id]) => id);
}

/** Whether this account was given this page to edit. */
export async function editsPage(userId: string, pageId: string): Promise<boolean> {
    const held = await host.accessGrants.liveGrants(userId, "status.page", pageId);
    return held.some((grant) => core.atLeast("status.page", grant.capability, "edit"));
}

/** Whether any page at all was shared with this account. */
export async function reachesAnyPage(userId: string): Promise<boolean> {
    return host.accessGrants.reachesAnySubject(userId, ["status.page"]);
}

/** Whether the signed-in person runs every page. */
export async function isStatusManager(user: AppHostTypes["SessionUser"]): Promise<boolean> {
    return host.session.sessionCan(user, "status.manage");
}

/** The signed-in person, refused unless they run status pages or were given
 *  every page these targets belong to. */
export async function requirePageEditor(targets: readonly PageTarget[]): Promise<{ id: string }> {
    const user = await host.session.requireUser();
    if (await isStatusManager(user)) return user;
    const pages = await pagesOf(targets);
    if (pages.length === 0) throw new StatusRefusal("errors.notAllowed");
    for (const pageId of new Set(pages)) {
        if (!pageId || !(await editsPage(user.id, pageId))) {
            throw new StatusRefusal("errors.notAllowed");
        }
    }
    return user;
}

/** Runs an action's work for an editor of these targets' pages. */
export async function pageOutcome<T extends object>(
    targets: readonly PageTarget[],
    work: (userId: string) => Promise<T>
): Promise<Outcome<T>> {
    return settle(() => requirePageEditor(targets), work);
}
