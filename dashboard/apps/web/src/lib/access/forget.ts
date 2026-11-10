/**
 * What deleting something has to take with it.
 *
 * A grant, a line of the access log, a follow, a comment and a line of history
 * all name what they are about by kind and id, with no foreign key - one table
 * serves every app. So nothing cascades: whatever deletes a subject (or a
 * person, team or role a grant is to) drops those rows itself, here, or they
 * stay on the disk about something that is no longer there.
 *
 * `forgetSubject` and `forgetPrincipal` are for a delete that knows the ids.
 * `sweepOrphanGrants` is for one that does not: an account, an organization or
 * a place takes dozens of things with it by cascade, and the grants on them are
 * matched against what is left rather than collected beforehand. The same
 * table below is what the `orphan_cleanup` migration ran once for what was
 * already left behind.
 */

import type * as core from "@polaris/core";
import { Prisma, prisma } from "@polaris/db";
import * as follow from "@/lib/follow/follow";
import * as activity from "@/lib/activity/activity";
import * as comments from "@/lib/comments/comments";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids per statement: a space with a hundred thousand tasks is many short
 *  deletes, never one statement with a hundred thousand parameters. */
export const FORGET_BATCH = 1000;

/** Rows per sweep statement, repeated until a pass finds fewer. */
export const SWEEP_BATCH = 5000;

/**
 * The table each kind of subject names by its id, or null where the id is not
 * a row: a fixed name (`dns.filter`, `watch.connectivity`) or a composite one
 * (`crm.record` is "<kind>:<uuid>"). `analytics.site` names a service, or - for
 * Polaris itself and a site run elsewhere - the site's own record, so a grant
 * on it is gone only when neither is left.
 */
export const SUBJECT_TABLES = {
    "chat.space": "ChatSpace",
    "chat.channel": "ChatChannel",
    "task.space": "TaskSpace",
    "task.folder": "TaskFolder",
    "note.space": "NoteSpace",
    "office.document": "OfficeDocument",
    "place.device": "PlaceDevice",
    "place.camera": "Camera",
    "place.ups": "Ups",
    "place.nas": "StorageConnection",
    "place.server": "Host",
    "place.domain": "Domain",
    "place.room": "PlaceRoom",
    "watch.connectivity": null,
    "watch.alarm": "Alarm",
    "status.page": "StatusPage",
    "calendar.calendar": "Calendar",
    "calendar.booking": "CalendarBookingPage",
    "crm.record": null,
    "crm.dashboard": "CrmDashboard",
    "automation.automation": "Automation",
    "analytics.site": ["Application", "AnalyticsSite"],
    "telemetry.project": "TelemetryProject",
    "backup.plan": "BackupPlan",
    "note.note": "Note",
    "dns.filter": null,
    "agents.session": "AgentSession",
    "polar.project": "PolarProject",
    "task.task": "Task",
    "place.place": "Place",
    "mail.mailbox": "MailAccount",
    "place.panel": "PlacePanel"
} as const satisfies Record<core.GrantSubject, string | readonly string[] | null>;

/** The table each kind of principal names. A link has no row behind it. */
export const PRINCIPAL_TABLES = {
    user: "User",
    team: "Team",
    role: "OrgRole"
} as const satisfies Record<core.GrantPrincipal, string>;

/** Grant kinds that also keep a history, a discussion and followers, in the
 *  vocabulary those tables use. */
const HISTORY_SUBJECT: Partial<Record<core.GrantSubject, activity.ActivitySubject>> = {
    "task.task": "task",
    "place.server": "host"
};

function chunks(ids: readonly string[]): string[][] {
    const unique = [...new Set(ids)].filter((id) => UUID.test(id));
    const out: string[][] = [];
    for (let at = 0; at < unique.length; at += FORGET_BATCH)
        out.push(unique.slice(at, at + FORGET_BATCH));
    return out;
}

/**
 * Everything kept about these subjects, gone: who they were lent to, the log of
 * those loans being used, and - for the kinds that have them - the history,
 * the discussion and the followers. Safe to call twice and for ids already
 * gone; an id that is not a row's (a fixed or composite name) is skipped.
 */
export async function forgetSubject(
    subject: core.GrantSubject,
    subjectIds: string | readonly string[],
    client: Prisma.TransactionClient = prisma
): Promise<void> {
    const alias = HISTORY_SUBJECT[subject];
    for (const ids of chunks(typeof subjectIds === "string" ? [subjectIds] : subjectIds)) {
        await client.accessGrant.deleteMany({
            where: { subjectType: subject, subjectId: { in: ids } }
        });
        await client.grantUse.deleteMany({ where: { subjectType: subject, subjectId: { in: ids } } });
        if (alias) {
            await activity.forget(alias, ids, client);
            await comments.forget(alias, ids, client);
            await follow.forget(alias, ids, client);
        }
    }
}

/** Every grant to these people, teams or roles, gone. */
export async function forgetPrincipal(
    principal: core.GrantPrincipal,
    principalIds: string | readonly string[],
    client: Prisma.TransactionClient = prisma
): Promise<void> {
    for (const ids of chunks(typeof principalIds === "string" ? [principalIds] : principalIds)) {
        await client.accessGrant.deleteMany({
            where: { principalType: principal, principalId: { in: ids } }
        });
    }
}

/** What a sweep matches a grant against: one kind of subject or principal and
 *  the table its id names. */
export interface OrphanTarget {
    readonly side: "subject" | "principal";
    readonly kind: string;
    /** Every table the id may name; the grant is an orphan when none has it. */
    readonly tables: readonly string[];
}

/** Every kind with a table, then every principal - straight from the
 *  constant maps above, never from data. */
export function orphanTargets(): OrphanTarget[] {
    const subjects: OrphanTarget[] = [];
    for (const [kind, table] of Object.entries(SUBJECT_TABLES) as [string, string | readonly string[] | null][])
        if (table !== null) subjects.push({ side: "subject", kind, tables: typeof table === "string" ? [table] : table });
    const principals = (Object.entries(PRINCIPAL_TABLES) as [string, string][]).map(
        ([kind, table]): OrphanTarget => ({ side: "principal", kind, tables: [table] })
    );
    return [...subjects, ...principals];
}

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const IDENTIFIER = /^[A-Z][A-Za-z]*$/;

/**
 * One batch of grants about something gone. The kind, the pattern and the
 * limit are parameters; only the table and column names are raw, and those
 * come from the constant maps above. The id is cast to uuid only when it is
 * shaped like one, so a fixed or composite name never reaches the cast.
 */
export function orphanGrantStatement(target: OrphanTarget, limit = SWEEP_BATCH): Prisma.Sql {
    for (const name of target.tables) if (!IDENTIFIER.test(name)) throw new Error(`not a table name: ${name}`);
    const kindColumn = Prisma.raw(target.side === "subject" ? '"subjectType"' : '"principalType"');
    const idColumn = Prisma.raw(target.side === "subject" ? '"subjectId"' : '"principalId"');
    const missing = Prisma.join(
        target.tables.map(
            (name) =>
                Prisma.sql`NOT EXISTS (SELECT 1 FROM ${Prisma.raw(`"${name}"`)} t WHERE t."id" = CASE WHEN g.${idColumn}::text ~* ${UUID_PATTERN} THEN g.${idColumn}::text::uuid END)`
        ),
        " AND "
    );
    return Prisma.sql`DELETE FROM "AccessGrant" WHERE "id" IN (SELECT g."id" FROM "AccessGrant" g WHERE g.${kindColumn} = ${target.kind} AND g.${idColumn}::text ~* ${UUID_PATTERN} AND ${missing} LIMIT ${limit})`;
}

/**
 * Drop every grant whose subject or principal no longer exists. For a delete
 * that takes more with it by cascade than it can name. Never throws: the
 * delete it follows has already happened, and a sweep that fails is caught up
 * by the next one.
 */
export async function sweepOrphanGrants(): Promise<number> {
    let total = 0;
    try {
        for (const target of orphanTargets()) {
            for (;;) {
                const count = await prisma.$executeRaw(orphanGrantStatement(target));
                total += count;
                if (count < SWEEP_BATCH) break;
            }
        }
    } catch (caught) {
        console.error("polaris: orphaned grants could not be swept:", caught);
    }
    return total;
}
