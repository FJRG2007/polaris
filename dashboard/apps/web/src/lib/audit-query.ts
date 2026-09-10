/**
 * Reading the audit trail a page at a time, narrowed, and handing all of it over
 * as a file.
 *
 * Three readers ask the same table three different questions - an administrator
 * everything, an organization what was done to it, a person what they did - and
 * each used to be capped at a few hundred rows with no way past the cap and no
 * way out of the screen. One query here answers all three, so the narrowing, the
 * paging and the export are the same code whichever screen asks.
 *
 * **Scope is part of the query, never a filter on the result.** An organization's
 * reader gets the entries that name the organization, a person gets the entries
 * they took, and nothing a filter parameter says can widen either - the scope is
 * decided by the route that authorized the caller and passed in here, not read
 * from the request.
 *
 * **Pages are keyset, newest first.** The trail is appended to while somebody is
 * scrolling it, and an offset would repeat an entry at every page boundary each
 * time something new arrived.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { Prisma } from "@polaris/db";
import { auditChainStatus } from "@/lib/audit-chain";

/** Whose entries a read is allowed to see. */
export type AuditScope =
    | { readonly kind: "all" }
    | { readonly kind: "org"; readonly orgId: string }
    | {
          readonly kind: "user";
          readonly userId: string;
          /** One session's entries; null for the ones that came from no session. */
          readonly sessionId?: string | null;
      };

/** One entry, ready to draw or to write into an export. */
export interface AuditEntry {
    readonly id: string;
    /** ISO 8601; formatted by the reader's own preferences on screen. */
    readonly at: string;
    readonly actorId: string | null;
    /** Who did it, as a name - "Polaris" for nothing signed in, "a former member"
     *  for an account that is gone. Never dropped: an audit trail may not lose an
     *  entry because the person behind it left. */
    readonly actorName: string;
    readonly action: string;
    readonly targetType: string | null;
    readonly targetId: string | null;
    /** The raw metadata document, or "" when the entry carried none. */
    readonly metadata: string;
    readonly sessionId: string | null;
    readonly orgId: string | null;
    /** The entry's place in the tamper-evident chain, or null until it is sealed. */
    readonly seq: string | null;
    readonly hash: string | null;
}

/** What a narrowing can pick from, so the filters offer only what is there. */
export interface AuditFacets {
    readonly actors: { id: string; name: string }[];
    readonly areas: string[];
    readonly resources: string[];
}

/** The `where` for one scope and one narrowing. Exported for the tests that pin
 *  that no filter can reach outside its scope. */
export function auditWhere(scope: AuditScope, filter: core.AuditFilter): Prisma.AuditLogWhereInput {
    const and: Prisma.AuditLogWhereInput[] = [];

    if (scope.kind === "org") and.push({ orgId: scope.orgId });
    if (scope.kind === "user") {
        and.push({ actorId: scope.userId });
        if (scope.sessionId !== undefined) and.push({ sessionId: scope.sessionId });
    }

    // Narrowing by actor inside a person's own history is narrowing by
    // themselves, so it is ignored there rather than being a way to ask about
    // somebody else under their scope.
    if (filter.actor && scope.kind !== "user") and.push({ actorId: filter.actor });
    if (filter.area) {
        and.push({ OR: [{ action: filter.area }, { action: { startsWith: `${filter.area}.` } }] });
    }
    if (filter.resource) and.push({ targetType: filter.resource });
    if (filter.q) {
        and.push({
            OR: [{ action: { contains: filter.q } }, { metadata: { contains: filter.q } }]
        });
    }
    if (filter.from) and.push({ at: { gte: filter.from } });
    if (filter.to) and.push({ at: { lte: filter.to } });

    const cursor = filter.cursor ? core.decodeAuditCursor(filter.cursor) : null;
    if (cursor) {
        and.push({
            OR: [{ at: { lt: cursor.at } }, { at: cursor.at, id: { lt: cursor.id } }]
        });
    }
    return and.length > 0 ? { AND: and } : {};
}

const ENTRY_COLUMNS = {
    id: true,
    at: true,
    actorId: true,
    action: true,
    targetType: true,
    targetId: true,
    metadata: true,
    sessionId: true,
    orgId: true,
    seq: true,
    hash: true
} as const;

type EntryRow = {
    id: string;
    at: Date;
    actorId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: string | null;
    sessionId: string | null;
    orgId: string | null;
    seq: bigint | null;
    hash: string | null;
};

/** How an account that did something reads, by id. One query for a page. */
async function actorNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) return new Map();
    const people = await prisma.user.findMany({
        where: { id: { in: unique } },
        select: { id: true, name: true, username: true }
    });
    return new Map(
        people.map((person) => [
            person.id,
            person.name || (person.username ? `@${person.username}` : "somebody")
        ])
    );
}

function drawn(row: EntryRow, names: Map<string, string>): AuditEntry {
    return {
        id: row.id,
        at: row.at.toISOString(),
        actorId: row.actorId,
        actorName: row.actorId ? (names.get(row.actorId) ?? "a former member") : "Polaris",
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        metadata: row.metadata ?? "",
        sessionId: row.sessionId,
        orgId: row.orgId,
        seq: row.seq?.toString() ?? null,
        hash: row.hash
    };
}

/** One page of entries, newest first, and where the next one starts. */
export async function queryAudit(
    scope: AuditScope,
    filter: core.AuditFilter
): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
    const rows = await prisma.auditLog.findMany({
        where: auditWhere(scope, filter),
        orderBy: [{ at: "desc" }, { id: "desc" }],
        // One more than asked, which is how "there is another page" is known
        // without counting the whole narrowing.
        take: filter.limit + 1,
        select: ENTRY_COLUMNS
    });
    const page = rows.slice(0, filter.limit);
    const names = await actorNames(page.map((row) => row.actorId));
    const last = page.at(-1);
    return {
        items: page.map((row) => drawn(row, names)),
        nextCursor:
            rows.length > filter.limit && last ? core.encodeAuditCursor(last.at, last.id) : null
    };
}

/** How many distinct people the actor filter offers at most. The ones who acted
 *  most recently: somebody hunting through a trail is hunting for recent work. */
const FACET_ACTORS = 200;

/**
 * What the filters can offer for one scope: the people, the areas and the kinds
 * of thing that appear in it.
 *
 * Grouped in the database rather than read off a page: the page is a slice, and
 * somebody whose entries have scrolled past it is exactly who a reader looks for.
 */
export async function auditFacets(scope: AuditScope): Promise<AuditFacets> {
    const where = auditWhere(scope, { limit: 1 });
    const [actors, actions, resources] = await Promise.all([
        scope.kind === "user"
            ? Promise.resolve([])
            : prisma.auditLog.groupBy({
                  by: ["actorId"],
                  where,
                  _max: { at: true },
                  orderBy: { _max: { at: "desc" } },
                  take: FACET_ACTORS
              }),
        prisma.auditLog.groupBy({ by: ["action"], where }),
        prisma.auditLog.groupBy({ by: ["targetType"], where })
    ]);
    const names = await actorNames(actors.map((group) => group.actorId));
    return {
        actors: actors
            .map((group) => group.actorId)
            .filter((id): id is string => Boolean(id))
            .map((id) => ({ id, name: names.get(id) ?? "a former member" }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        areas: [...new Set(actions.map((group) => core.auditArea(group.action)))].sort(),
        resources: resources
            .map((group) => group.targetType)
            .filter((type): type is string => Boolean(type))
            .sort()
    };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** The most one export carries. Past this the file says it was cut short rather
 *  than a request holding a connection open for an hour. */
export const AUDIT_EXPORT_MAX = 500_000;

/** Rows read per round trip while an export streams. */
const EXPORT_BATCH = 1000;

const CSV_COLUMNS = [
    "id",
    "at",
    "seq",
    "actor_id",
    "actor",
    "action",
    "target_type",
    "target_id",
    "org_id",
    "session_id",
    "metadata",
    "hash"
] as const;

function csvLine(entry: AuditEntry): string {
    return (
        [
            entry.id,
            entry.at,
            entry.seq ?? "",
            entry.actorId ?? "",
            entry.actorName,
            entry.action,
            entry.targetType ?? "",
            entry.targetId ?? "",
            entry.orgId ?? "",
            entry.sessionId ?? "",
            entry.metadata,
            entry.hash ?? ""
        ]
            // Guarded against formula injection: an action's metadata carries names
            // people typed, and a cell starting with `=` is a formula to a spreadsheet.
            .map(core.csvField)
            .join(",")
    );
}

/** What an export says about itself, at the top of a JSON file. */
export interface AuditExportMeta {
    readonly scope: string;
    readonly total: number;
    readonly truncated: boolean;
}

/** How many entries an export of this scope and narrowing would carry, so the
 *  response can say before the first byte whether it will be cut short. */
export async function auditExportCount(
    scope: AuditScope,
    filter: core.AuditFilter
): Promise<number> {
    return prisma.auditLog.count({ where: auditWhere(scope, { ...filter, cursor: undefined }) });
}

/**
 * The whole narrowing, streamed, as CSV or as JSON.
 *
 * Read in keyset batches rather than all at once, so an export of a year of
 * history starts arriving at once and never holds the whole trail in memory. The
 * JSON document opens with the chain's head - its place and hash at the moment of
 * export - which is the copy to keep somewhere else: it is what lets the trail be
 * checked later for entries removed from its newest end, the one change the
 * chain cannot catch on its own.
 */
export function streamAuditExport(
    scope: AuditScope,
    filter: core.AuditFilter,
    format: core.AuditExportFormat,
    meta: AuditExportMeta
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let cursor: string | undefined;
    let sent = 0;
    let started = false;

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                if (!started) {
                    started = true;
                    if (format === "csv") {
                        controller.enqueue(encoder.encode(`${CSV_COLUMNS.join(",")}\r\n`));
                    } else {
                        const chain = await auditChainStatus();
                        const head = {
                            exportedAt: new Date().toISOString(),
                            scope: meta.scope,
                            total: meta.total,
                            truncated: meta.truncated,
                            filters: {
                                actor: filter.actor ?? null,
                                area: filter.area ?? null,
                                q: filter.q ?? null,
                                resource: filter.resource ?? null,
                                from: filter.from?.toISOString() ?? null,
                                to: filter.to?.toISOString() ?? null
                            },
                            chain: { head: chain.head, checkpoint: chain.checkpoint }
                        };
                        const opening = JSON.stringify(head).slice(0, -1);
                        controller.enqueue(encoder.encode(`${opening},"entries":[`));
                    }
                }

                const remaining = AUDIT_EXPORT_MAX - sent;
                const page =
                    remaining > 0
                        ? await queryAudit(scope, {
                              ...filter,
                              cursor,
                              limit: Math.min(EXPORT_BATCH, remaining)
                          })
                        : { items: [], nextCursor: null };

                // The screen's page ceiling is a property of the request schema,
                // not of the query, so an export reads in its own larger batches.
                const lines = page.items.map((entry, index) =>
                    format === "csv"
                        ? `${csvLine(entry)}\r\n`
                        : `${sent + index === 0 ? "" : ","}${JSON.stringify(entry)}`
                );
                if (lines.length > 0) controller.enqueue(encoder.encode(lines.join("")));
                sent += page.items.length;
                cursor = page.nextCursor ?? undefined;

                if (!page.nextCursor || sent >= AUDIT_EXPORT_MAX) {
                    if (format === "json") controller.enqueue(encoder.encode("]}"));
                    controller.close();
                }
            } catch (caught) {
                console.error("polaris: an audit export failed partway:", caught);
                controller.error(caught);
            }
        }
    });
}

/** The name an export is saved under: what it is of, and when. */
export function auditExportFilename(label: string, format: core.AuditExportFormat): string {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const safe =
        label
            .replace(/[^a-z0-9-]+/gi, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase() || "activity";
    return `${safe}-audit-${stamp}.${format}`;
}
