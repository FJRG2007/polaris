/**
 * Who owns a shareable thing, for the first row of "People with access".
 *
 * Every subject keeps its owner in its own words - `ownerId` on a space,
 * `userId` on a note or a mailbox, the project's owner for a domain - so this is
 * one small reader per subject, each a single batched `findMany` over the ids it
 * is given. Things nobody owns (the house's doors and cameras, the network
 * filter, the internet record) have no reader and resolve to nothing, which the
 * dialog draws as the person sharing instead.
 */

import { prisma } from "@polaris/db";
import type * as core from "@polaris/core";

type OwnerPairs = Promise<readonly (readonly [string, string | null])[]>;
type OwnerReader = (ids: string[]) => OwnerPairs;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read `ownerId`-style column `column` off `model` for these ids. */
function byColumn(model: string, column: string, fallback?: string): OwnerReader {
    return async (ids) => {
        const delegate = (prisma as unknown as Record<string, {
            findMany(args: unknown): Promise<Record<string, string | null>[]>;
        }>)[model];
        const select: Record<string, true> = { id: true, [column]: true };
        if (fallback) select[fallback] = true;
        const rows = await delegate!.findMany({ where: { id: { in: ids } }, select });
        return rows.map((row) => [
            row.id as string,
            row[column] ?? (fallback ? (row[fallback] ?? null) : null)
        ]);
    };
}

const READERS: Partial<Record<core.GrantSubject, OwnerReader>> = {
    "chat.space": byColumn("chatSpace", "ownerId"),
    "chat.channel": byColumn("chatChannel", "ownerId", "createdById"),
    "task.space": byColumn("taskSpace", "ownerId"),
    "note.space": byColumn("noteSpace", "ownerId"),
    "note.note": byColumn("note", "userId"),
    "office.document": byColumn("officeDocument", "ownerId"),
    "place.nas": byColumn("storageConnection", "ownerId"),
    "place.server": byColumn("host", "ownerId"),
    "watch.alarm": byColumn("alarm", "ownerId"),
    "status.page": byColumn("statusPage", "createdById"),
    "calendar.calendar": byColumn("calendar", "ownerId"),
    "calendar.booking": byColumn("calendarBookingPage", "ownerId"),
    "crm.dashboard": byColumn("crmDashboard", "userId", "createdById"),
    "automation.automation": byColumn("automation", "userId"),
    "telemetry.project": byColumn("telemetryProject", "ownerId"),
    "backup.plan": byColumn("backupPlan", "ownerId"),
    "polar.project": byColumn("polarProject", "ownerId"),
    "mail.mailbox": byColumn("mailAccount", "userId"),
    // A folder and a task belong to whoever owns the space they sit in.
    "task.folder": async (ids) =>
        (
            await prisma.taskFolder.findMany({
                where: { id: { in: ids } },
                select: { id: true, space: { select: { ownerId: true } } }
            })
        ).map((row) => [row.id, row.space?.ownerId ?? null] as const),
    "task.task": async (ids) =>
        (
            await prisma.task.findMany({
                where: { id: { in: ids } },
                select: { id: true, space: { select: { ownerId: true } } }
            })
        ).map((row) => [row.id, row.space?.ownerId ?? null] as const),
    // A domain and a service's numbers belong to whoever owns the project.
    "place.domain": async (ids) =>
        (
            await prisma.domain.findMany({
                where: { id: { in: ids } },
                select: {
                    id: true,
                    application: {
                        select: { environment: { select: { project: { select: { ownerId: true } } } } }
                    }
                }
            })
        ).map((row) => [row.id, row.application?.environment?.project?.ownerId ?? null] as const),
    "analytics.site": async (ids) =>
        (
            await prisma.application.findMany({
                where: { id: { in: ids } },
                select: {
                    id: true,
                    environment: { select: { project: { select: { ownerId: true } } } }
                }
            })
        ).map((row) => [row.id, row.environment?.project?.ownerId ?? null] as const),
    // A workspace is its repository owner's, or whoever started it.
    "agents.session": async (ids) =>
        (
            await prisma.agentSession.findMany({
                where: { id: { in: ids } },
                select: { id: true, startedById: true, repo: { select: { ownerId: true } } }
            })
        ).map((row) => [row.id, row.repo?.ownerId ?? row.startedById ?? null] as const),
    // "<kind>:<uuid>": one read per kind present, never one per record.
    "crm.record": async (ids) => {
        const kinds = { companies: "crmCompany", people: "crmPerson", opportunities: "crmOpportunity" };
        const pairs: (readonly [string, string | null])[] = [];
        for (const [kind, model] of Object.entries(kinds)) {
            const wanted = ids
                .filter((id) => id.startsWith(`${kind}:`))
                .map((id) => id.slice(kind.length + 1))
                .filter((id) => UUID.test(id));
            if (wanted.length === 0) continue;
            for (const [id, owner] of await byColumn(model, "userId", "createdById")(wanted)) {
                pairs.push([`${kind}:${id}`, owner]);
            }
        }
        return pairs;
    }
};

/** Whether this kind of thing has an owner at all. */
export function subjectHasOwner(subject: core.GrantSubject): boolean {
    return subject in READERS;
}

/**
 * The owner's account id for each of these things, one query per call. An id
 * with no row, or a row with no owner, is simply absent from the map.
 */
export async function subjectOwnerIds(
    subject: core.GrantSubject,
    subjectIds: readonly string[]
): Promise<Map<string, string>> {
    const read = READERS[subject];
    const ids = [...new Set(subjectIds)].filter((id) =>
        subject === "crm.record" ? id.includes(":") : UUID.test(id)
    );
    if (!read || ids.length === 0) return new Map();
    const owners = new Map<string, string>();
    for (const [id, owner] of await read(ids)) if (owner) owners.set(id, owner);
    return owners;
}

/** The owner as the share dialog's first row draws them. */
export interface SubjectOwner {
    readonly id: string;
    readonly name: string;
    /** What may be printed under the name for this viewer: see `contactLines`. */
    readonly contact: string;
}

/**
 * The owner of one thing, named for this viewer, or null when it has none - or
 * the account behind it is gone.
 */
export async function subjectOwner(
    viewer: { id: string; isAdmin: boolean },
    subject: core.GrantSubject,
    subjectId: string
): Promise<SubjectOwner | null> {
    const ownerId = (await subjectOwnerIds(subject, [subjectId])).get(subjectId);
    if (!ownerId) return null;
    const person = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { id: true, name: true, username: true, email: true }
    });
    if (!person) return null;
    const { contactLines } = await import("@/lib/privacy-service");
    const contacts = await contactLines(viewer, [person]);
    return {
        id: person.id,
        name: person.name || person.username || "",
        contact: contacts.get(person.id) ?? ""
    };
}
