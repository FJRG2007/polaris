/**
 * Calendars: the list somebody sees, and what they may change about each.
 *
 * What belongs to the calendar (name, colour, zone, default reminders) is
 * changed by its owner or a manager; how one reader shows it (hidden, their own
 * colour, its place in their list) is theirs alone and lives in
 * CalendarDisplay, so a sharee reordering their list never reorders anybody
 * else's.
 *
 * Server-only.
 */

import { calendarT } from "./i18n";
import { ensurePersonalCalendarFor } from "./personal";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { CalendarRefusal } from "./errors";
import type { CalendarInput, CalendarPatch } from "./schemas";
import type { CalendarSummary, DefaultAlarms, ResourceInfo, SourceKind } from "./wire";
import { reachableCalendars, requireCalendar, reaches, type Reach, type SessionUser } from "./access";

const NO_ALARMS: DefaultAlarms = { timed: [], allDay: [] };

/** Read a calendar's stored default reminders. */
export function readDefaultAlarms(raw: string): DefaultAlarms {
    try {
        const parsed = JSON.parse(raw) as { timed?: unknown; allDay?: unknown };
        const list = (value: unknown) =>
            Array.isArray(value) ? value.filter((entry): entry is number => Number.isInteger(entry)).slice(0, 5) : [];
        return { timed: list(parsed.timed), allDay: list(parsed.allDay) };
    } catch {
        return NO_ALARMS;
    }
}

/** Read a room's stored attributes. */
export function readResource(raw: string): ResourceInfo | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<ResourceInfo>;
        return {
            type: parsed.type === "equipment" ? "equipment" : "room",
            capacity: typeof parsed.capacity === "number" ? parsed.capacity : null,
            building: typeof parsed.building === "string" ? parsed.building : "",
            floor: typeof parsed.floor === "string" ? parsed.floor : "",
            features: Array.isArray(parsed.features)
                ? parsed.features.filter((entry): entry is string => typeof entry === "string")
                : []
        };
    } catch {
        return null;
    }
}

const SUMMARY_COLUMNS = {
    id: true,
    ownerId: true,
    name: true,
    description: true,
    color: true,
    timezone: true,
    components: true,
    kind: true,
    readOnly: true,
    transparent: true,
    alarmsMuted: true,
    defaultAlarms: true,
    publicMode: true,
    publicToken: true,
    resource: true,
    createdAt: true,
    owner: { select: { id: true, name: true } },
    source: { select: { id: true, kind: true, label: true, status: true, lastSyncAt: true } },
    _count: { select: { shares: true } }
} as const;

type SummaryRow = {
    id: string;
    ownerId: string;
    name: string;
    description: string;
    color: string;
    timezone: string;
    components: string;
    kind: string;
    readOnly: boolean;
    transparent: boolean;
    alarmsMuted: boolean;
    defaultAlarms: string;
    publicMode: string;
    publicToken: string | null;
    resource: string;
    createdAt: Date;
    owner: { id: string; name: string };
    source: { id: string; kind: string; label: string; status: string; lastSyncAt: Date | null } | null;
    _count: { shares: number };
};

function summarize(
    row: SummaryRow,
    reach: Reach,
    display: { hidden: boolean; color: string | null; position: number } | undefined,
    index: number
): CalendarSummary {
    const owner = reach === "owner";
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        color: display?.color ?? row.color,
        ownColor: row.color,
        timezone: row.timezone,
        components: row.components.split(",").filter((part): part is "VEVENT" | "VTODO" => part === "VEVENT" || part === "VTODO"),
        kind: (["local", "remote", "resource", "birthdays"] as const).find((kind) => kind === row.kind) ?? "local",
        source: row.source
            ? {
                  id: row.source.id,
                  kind: row.source.kind as SourceKind,
                  label: row.source.label,
                  status: row.source.status,
                  lastSyncAt: row.source.lastSyncAt?.toISOString() ?? null
              }
            : null,
        reach,
        owner: owner ? null : { id: row.owner.id, name: row.owner.name },
        hidden: display?.hidden ?? false,
        position: display?.position ?? 1000 + index,
        writable: reaches(reach, "write") && !row.readOnly,
        transparent: row.transparent,
        alarmsMuted: row.alarmsMuted,
        defaultAlarms: readDefaultAlarms(row.defaultAlarms),
        // What only the owner and managers see: whether and how it is published.
        publicMode: reaches(reach, "manage") ? ((row.publicMode as CalendarSummary["publicMode"]) ?? "") : "",
        publicToken: reaches(reach, "manage") ? row.publicToken : null,
        resource: readResource(row.resource),
        shareCount: reaches(reach, "manage") ? row._count.shares : 0
    };
}

/** Make sure somebody opening the Calendar has a calendar of their own. */
export async function ensurePersonalCalendar(user: SessionUser): Promise<void> {
    await ensurePersonalCalendarFor(user.id);
}

/** Every calendar this person reaches, in their order. Rooms are not listed -
 *  they are booked from an event, not browsed. */
export async function listCalendars(user: SessionUser): Promise<CalendarSummary[]> {
    await ensurePersonalCalendar(user);
    const reach = await reachableCalendars(user.id);
    const ids = [...reach.keys()];
    if (ids.length === 0) return [];
    const [rows, displays] = await Promise.all([
        prisma.calendar.findMany({
            where: { id: { in: ids }, trashedAt: null, kind: { not: "resource" } },
            select: SUMMARY_COLUMNS,
            orderBy: { createdAt: "asc" }
        }),
        prisma.calendarDisplay.findMany({
            where: { userId: user.id, calendarId: { in: ids } },
            select: { calendarId: true, hidden: true, color: true, position: true }
        })
    ]);
    const byId = new Map(displays.map((display) => [display.calendarId, display]));
    return rows
        .map((row, index) => summarize(row as SummaryRow, reach.get(row.id)!, byId.get(row.id), index))
        .sort((left, right) => left.position - right.position);
}

/** One calendar as the sidebar draws it, for a screen that has just changed it. */
export async function calendarSummary(user: SessionUser, calendarId: string): Promise<CalendarSummary> {
    const found = (await listCalendars(user)).find((calendar) => calendar.id === calendarId);
    if (!found) throw new CalendarRefusal((await calendarT())("errors.calendarNotFound"));
    return found;
}

/** A new calendar of this person's own. */
export async function createCalendar(user: SessionUser, input: CalendarInput): Promise<string> {
    const created = await prisma.calendar.create({
        data: {
            ownerId: user.id,
            name: input.name,
            color: input.color,
            description: input.description,
            timezone: input.timezone,
            components: input.components,
            defaultAlarms: JSON.stringify({ timed: [-10], allDay: [-900] })
        },
        select: { id: true }
    });
    return created.id;
}

/**
 * Change what belongs to a calendar. Its owner or a manager; a calendar synced
 * from a provider keeps the provider's name, so only its colour, reminders and
 * how it counts toward busy are Polaris's to change.
 */
export async function updateCalendar(user: SessionUser, calendarId: string, patch: CalendarPatch): Promise<void> {
    const calendar = await requireCalendar(user.id, calendarId, "manage");
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined && calendar.kind !== "remote") data.name = patch.name;
    if (patch.description !== undefined && calendar.kind !== "remote") data.description = patch.description;
    if (patch.color !== undefined) data.color = patch.color;
    if (patch.timezone !== undefined) data.timezone = patch.timezone;
    if (patch.transparent !== undefined) data.transparent = patch.transparent;
    if (patch.alarmsMuted !== undefined) data.alarmsMuted = patch.alarmsMuted;
    if (patch.defaultAlarms !== undefined) data.defaultAlarms = JSON.stringify(patch.defaultAlarms);
    if (Object.keys(data).length === 0) return;
    await prisma.calendar.update({ where: { id: calendar.id }, data });
}

/** How this reader shows a calendar: hidden or not, and a colour of their own. */
export async function setDisplay(
    user: SessionUser,
    calendarId: string,
    patch: { hidden?: boolean; color?: string | null }
): Promise<void> {
    await requireCalendar(user.id, calendarId, "freebusy");
    await prisma.calendarDisplay.upsert({
        where: { calendarId_userId: { calendarId, userId: user.id } },
        create: { calendarId, userId: user.id, hidden: patch.hidden ?? false, color: patch.color ?? null },
        update: {
            ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
            ...(patch.color !== undefined ? { color: patch.color } : {})
        }
    });
}

/** This reader's order of their calendars. Ids they do not reach are ignored. */
export async function reorderCalendars(user: SessionUser, orderedIds: readonly string[]): Promise<void> {
    const reach = await reachableCalendars(user.id);
    const ids = orderedIds.filter((id) => reach.has(id));
    await prisma.$transaction(
        ids.map((calendarId, position) =>
            prisma.calendarDisplay.upsert({
                where: { calendarId_userId: { calendarId, userId: user.id } },
                create: { calendarId, userId: user.id, position },
                update: { position }
            })
        )
    );
}

/**
 * Put a calendar in the trash. Only its owner: a sharee removes it from their
 * own list instead (`leaveCalendar`). A calendar synced from a provider is
 * removed from Polaris only - deleting somebody's Google calendar from here
 * would be a surprise nobody could undo.
 */
export async function trashCalendar(user: SessionUser, calendarId: string): Promise<void> {
    const calendar = await requireCalendar(user.id, calendarId, "owner");
    await prisma.calendar.update({ where: { id: calendar.id }, data: { trashedAt: new Date() } });
    await prisma.calendarReminder.deleteMany({ where: { object: { calendarId: calendar.id } } });
}

/**
 * Take a calendar somebody shared out of this reader's list: the share to them
 * goes; one through a team cannot be undone for one member, so it is hidden.
 */
export async function leaveCalendar(user: SessionUser, calendarId: string): Promise<void> {
    const calendar = await requireCalendar(user.id, calendarId, "freebusy");
    if (calendar.reach === "owner") throw new CalendarRefusal((await calendarT())("errors.ownCalendar"));
    const removed = await prisma.calendarShare.deleteMany({ where: { calendarId, userId: user.id } });
    const still = await reachableCalendars(user.id);
    if (removed.count === 0 || still.has(calendarId)) await setDisplay(user, calendarId, { hidden: true });
    await prisma.calendarReminder.deleteMany({ where: { userId: user.id, object: { calendarId } } });
}

/** The zone new events in a calendar are written in: its own, else the reader's. */
export function zoneFor(calendarZone: string, readerZone: string): string {
    return calendarZone || readerZone;
}

/** Whether this person administers the instance, which decides whether they may
 *  point Polaris at an address on its own network. */
export async function mayReachLan(user: SessionUser): Promise<boolean> {
    return user.isAdmin || (await host.session.sessionCan(user, "settings.manage"));
}
