/**
 * The targets a firewall scope can name, a page at a time, filtered and ordered
 * in the database by name then id.
 *
 * Each kind reads exactly what the page used to hold in full: the projects,
 * environments and services the caller can see (`visibleProjectWhere`), their own
 * servers and server groups, and their marketplace installs whose service they
 * can see - so the shortcut never becomes a way round the service list's
 * ownership.
 */

import { prisma, type Prisma } from "@polaris/db";
import { encodeServerCursor } from "@/lib/server-options";
import { visibleProjectWhere } from "@/lib/deploy-service";
import { installedAppScopeLabel } from "@/lib/apps/install-service";
import type { FirewallScopeOption, FirewallTargetKind } from "@/lib/firewall-scope-options-schema";
import {
    afterCursor,
    pageOf,
    type OptionsPage,
    type PageRequest
} from "@/lib/deploy-target-options";

type Where = Record<string, unknown>;

/** The id, search and cursor clauses every kind shares. */
function pageWhere(request: PageRequest, search: Where[]): Where[] {
    const and: Where[] = [];
    if (request.ids) and.push({ id: { in: [...request.ids] } });
    if (request.query) and.push({ OR: search });
    and.push(...afterCursor(request.cursor));
    return and;
}

const named = (query: string) => ({ name: { contains: query, mode: "insensitive" as const } });
const order = [{ name: "asc" as const }, { id: "asc" as const }];
const unplaced = (row: { id: string; name: string }) => ({
    id: row.id,
    name: row.name,
    path: null
});

export async function readFirewallScopeOptions(
    userId: string,
    kind: FirewallTargetKind,
    request: PageRequest
): Promise<OptionsPage<FirewallScopeOption>> {
    const take = request.limit + 1;
    const q = request.query;
    const select = { id: true, name: true } as const;
    switch (kind) {
        case "server": {
            const where = { AND: [{ ownerId: userId }, ...pageWhere(request, [named(q)])] };
            const rows = await prisma.host.findMany({
                where: where as Prisma.HostWhereInput,
                select,
                orderBy: order,
                take
            });
            return pageOf(rows, request.limit, unplaced);
        }
        case "server-group": {
            const where = { AND: [{ ownerId: userId }, ...pageWhere(request, [named(q)])] };
            const rows = await prisma.hostGroup.findMany({
                where: where as Prisma.HostGroupWhereInput,
                select,
                orderBy: order,
                take
            });
            return pageOf(rows, request.limit, unplaced);
        }
        case "project": {
            const where = {
                AND: [await visibleProjectWhere(userId), ...pageWhere(request, [named(q)])]
            };
            const rows = await prisma.project.findMany({
                where: where as Prisma.ProjectWhereInput,
                select,
                orderBy: order,
                take
            });
            return pageOf(rows, request.limit, unplaced);
        }
        case "environment": {
            const visible = await visibleProjectWhere(userId);
            const where = {
                AND: [
                    { project: visible },
                    ...pageWhere(request, [named(q), { project: named(q) }])
                ]
            };
            const rows = await prisma.environment.findMany({
                where: where as Prisma.EnvironmentWhereInput,
                select: { id: true, name: true, project: { select: { name: true } } },
                orderBy: order,
                take
            });
            return pageOf(rows, request.limit, (row) => ({
                id: row.id,
                name: row.name,
                path: row.project.name
            }));
        }
        case "application": {
            const visible = await visibleProjectWhere(userId);
            const where = {
                AND: [
                    { binnedAt: null, environment: { project: visible } },
                    ...pageWhere(request, [named(q), { environment: { project: named(q) } }])
                ]
            };
            const rows = await prisma.application.findMany({
                where: where as Prisma.ApplicationWhereInput,
                select: {
                    id: true,
                    name: true,
                    environment: { select: { name: true, project: { select: { name: true } } } }
                },
                orderBy: order,
                take
            });
            return pageOf(rows, request.limit, (row) => ({
                id: row.id,
                name: row.name,
                path: `${row.environment.project.name} / ${row.environment.name}`
            }));
        }
        case "marketplace":
            return readMarketplaceOptions(userId, request);
    }
}

/**
 * Installs are keyed by their service: the option's id is the service's, which is
 * what a rule is written against. An install has no relation to its service, so
 * the services of one page are read by id, and an install whose service the caller
 * cannot see is dropped from the page - the cursor still moves past it.
 */
async function readMarketplaceOptions(
    userId: string,
    request: PageRequest
): Promise<OptionsPage<FirewallScopeOption>> {
    const and: Prisma.InstalledAppWhereInput[] = [
        { ownerId: userId, status: { not: "removed" }, applicationId: { not: null } }
    ];
    if (request.ids) and.push({ applicationId: { in: [...request.ids] } });
    if (request.query) and.push(named(request.query));
    and.push(...(afterCursor(request.cursor) as Prisma.InstalledAppWhereInput[]));
    const rows = await prisma.installedApp.findMany({
        where: { AND: and },
        select: { id: true, name: true, catalogId: true, applicationId: true },
        orderBy: order,
        take: request.limit + 1
    });
    const page = rows.slice(0, request.limit);
    const serviceIds = page.map((row) => row.applicationId as string);
    const seen =
        serviceIds.length === 0
            ? []
            : await prisma.application.findMany({
                  where: {
                      id: { in: serviceIds },
                      binnedAt: null,
                      environment: { project: await visibleProjectWhere(userId) }
                  },
                  select: { id: true }
              });
    const visible = new Set(seen.map((row) => row.id));
    const last = page[page.length - 1];
    return {
        items: page
            .filter((row) => visible.has(row.applicationId as string))
            .map((row) => ({
                id: row.applicationId as string,
                name: installedAppScopeLabel(row.name, row.catalogId),
                path: null
            })),
        next: rows.length > request.limit && last ? encodeServerCursor(last.name, last.id) : null
    };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The target a link names when the caller may use it, else their first one.
 * `refused` is a named id that is not theirs - the page answers it with a 404
 * rather than quietly rewriting a link to someone else's rules into their own.
 */
export async function resolveFirewallScope(
    userId: string,
    kind: FirewallTargetKind,
    id: string | undefined
): Promise<{ option: FirewallScopeOption | null; refused: boolean }> {
    if (id) {
        if (!UUID.test(id)) return { option: null, refused: true };
        const page = await readFirewallScopeOptions(userId, kind, {
            query: "",
            cursor: null,
            limit: 1,
            ids: [id]
        });
        const option = page.items[0] ?? null;
        return { option, refused: !option };
    }
    // A page rather than one row: a marketplace page can drop an install whose
    // service the caller cannot see.
    const first = await readFirewallScopeOptions(userId, kind, {
        query: "",
        cursor: null,
        limit: 20
    });
    return { option: first.items[0] ?? null, refused: false };
}

/** How the page labels the chosen target. */
export function firewallScopeLabel(option: FirewallScopeOption): string {
    return option.path ? `${option.path} / ${option.name}` : option.name;
}
