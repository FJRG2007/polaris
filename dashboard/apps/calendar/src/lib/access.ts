/**
 * Who reaches a calendar, and how far.
 *
 * One sentence: a calendar is reached by its owner, by the people and teams it
 * is shared with at the level it was shared, and - for a room or a piece of
 * equipment - by everybody who may use the Calendar, as far as seeing when it is
 * taken. There is no administrator override for somebody else's calendar: an
 * operator runs the instance, not other people's diaries.
 *
 * Every read and write narrows by these rules inside the query; nothing fetches
 * a calendar and checks afterwards.
 *
 * Server-only.
 */

import { calendarT } from "./i18n";
import type * as engine from "../engine";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { CalendarRefusal } from "./errors";
import type { AppHostTypes } from "@polaris/app-host";

export type SessionUser = AppHostTypes["SessionUser"];

/** What a share grants, weakest first. */
export const SHARE_LEVELS = ["freebusy", "read", "write", "manage"] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];

/** How far one person reaches one calendar. */
export type Reach = "owner" | ShareLevel;

const RANK: Record<Reach, number> = { freebusy: 1, read: 2, write: 3, manage: 4, owner: 5 };

/** Whether `held` is at least `wanted`. */
export function reaches(held: Reach | null, wanted: Reach): boolean {
    return held !== null && RANK[held] >= RANK[wanted];
}

/** The stronger of two levels. */
function stronger(left: Reach | null, right: Reach): Reach {
    return left && RANK[left] >= RANK[right] ? left : right;
}

/** The signed-in person, refusing anybody without the Calendar. */
export async function requireCalendarUser(): Promise<SessionUser> {
    return host.session.requirePermission("calendar.use");
}

/** The same for an API route: a Response to return when refused. */
export async function apiCalendarUser(): Promise<SessionUser | Response> {
    const user = await host.apiSession.apiUser();
    if (user instanceof Response) return user;
    if (!(await host.session.sessionCan(user, "calendar.use"))) {
        return new Response(null, { status: 403 });
    }
    return user;
}

/** One calendar as the rules see it. */
interface Reachable {
    readonly id: string;
    readonly ownerId: string;
    readonly kind: string;
    readonly trashedAt: Date | null;
}

/**
 * How far every one of these calendars reaches for this person, in two reads -
 * the calendars and every share that could apply - however many there are.
 */
export async function reachOf(
    userId: string,
    calendars: readonly Reachable[]
): Promise<Map<string, Reach>> {
    const found = new Map<string, Reach>();
    const others: string[] = [];
    for (const calendar of calendars) {
        if (calendar.ownerId === userId) found.set(calendar.id, "owner");
        else if (calendar.trashedAt === null) others.push(calendar.id);
    }
    if (others.length === 0) return found;
    const teams = await host.calendarHost.teamIdsOf(userId);
    const shares = await prisma.calendarShare.findMany({
        where: {
            calendarId: { in: others },
            OR: [{ userId }, ...(teams.length > 0 ? [{ teamId: { in: teams } }] : [])]
        },
        select: { calendarId: true, access: true }
    });
    for (const share of shares) {
        const level = (SHARE_LEVELS as readonly string[]).includes(share.access)
            ? (share.access as ShareLevel)
            : "read";
        found.set(share.calendarId, stronger(found.get(share.calendarId) ?? null, level));
    }
    // A room is seen as taken or free by everybody who books rooms.
    for (const calendar of calendars) {
        if (calendar.kind === "resource" && !found.has(calendar.id) && calendar.trashedAt === null) {
            found.set(calendar.id, "freebusy");
        }
    }
    return found;
}

/** The ids of every calendar this person reaches, with how far. Their own, and
 *  every one shared with them or a team they are on; never a trashed one that
 *  is not theirs. */
export async function reachableCalendars(userId: string): Promise<Map<string, Reach>> {
    const teams = await host.calendarHost.teamIdsOf(userId);
    const rows = await prisma.calendar.findMany({
        where: {
            OR: [
                { ownerId: userId },
                {
                    trashedAt: null,
                    shares: {
                        some: {
                            OR: [{ userId }, ...(teams.length > 0 ? [{ teamId: { in: teams } }] : [])]
                        }
                    }
                }
            ]
        },
        select: { id: true, ownerId: true, kind: true, trashedAt: true }
    });
    return reachOf(
        userId,
        rows.filter((row) => row.trashedAt === null || row.ownerId === userId)
    );
}

/**
 * One calendar, refusing unless this person reaches it at least as far as
 * `wanted`. Unknown and unreachable read the same, so an id cannot be used to
 * learn which calendars exist.
 */
export async function requireCalendar(
    userId: string,
    calendarId: string,
    wanted: Reach
): Promise<{
    id: string;
    ownerId: string;
    kind: string;
    readOnly: boolean;
    sourceId: string | null;
    reach: Reach;
}> {
    const row = await prisma.calendar.findUnique({
        where: { id: calendarId },
        select: { id: true, ownerId: true, kind: true, trashedAt: true, readOnly: true, sourceId: true }
    });
    const reach = row ? ((await reachOf(userId, [row])).get(row.id) ?? null) : null;
    if (!row || row.trashedAt || !reaches(reach, wanted)) {
        throw new CalendarRefusal((await calendarT())("errors.calendarNotFound"));
    }
    return { id: row.id, ownerId: row.ownerId, kind: row.kind, readOnly: row.readOnly, sourceId: row.sourceId, reach: reach! };
}

/** A calendar this person may write events into: at least write, and not a
 *  read-only one (a subscription, a provider calendar they may only read). */
export async function requireWritableCalendar(userId: string, calendarId: string) {
    const calendar = await requireCalendar(userId, calendarId, "write");
    if (calendar.readOnly) throw new CalendarRefusal((await calendarT())("errors.readOnly"));
    return calendar;
}

/** An event reduced to the time it takes, for a reader who may not see it. */
export function busyBlock(event: engine.CalendarEvent, summary = ""): engine.CalendarEvent {
    return {
        ...event,
        summary,
        description: "",
        location: "",
        url: "",
        conference: "",
        categories: [],
        attendees: [],
        alarms: [],
        attachments: [],
        organizer: null,
        color: null,
        extra: [],
        extraComponents: []
    };
}

/** A task's CLASS, which the engine keeps among the lines it does not model.
 *  A value nobody knows is private, as RFC 5545 asks. */
export function todoClassification(todo: engine.CalendarTodo): engine.Classification {
    const line = todo.extra.find((extra) => /^CLASS[;:]/i.test(extra.line))?.line;
    if (!line) return "PUBLIC";
    const value = line.slice(line.lastIndexOf(":") + 1).trim().toUpperCase();
    return value === "PUBLIC" || value === "CONFIDENTIAL" ? value : "PRIVATE";
}

/**
 * An item as a reader below `write` may see it: public events in full, every
 * other event as a busy block, a task only when it is public. Null when nothing
 * of it may be seen.
 */
export function forReader(item: engine.CalendarItem): engine.CalendarItem | null {
    if (item.component === "VTODO") return todoClassification(item.todo) === "PUBLIC" ? item : null;
    const map = (event: engine.CalendarEvent) => (event.classification === "PUBLIC" ? event : busyBlock(event));
    return { ...item, master: item.master ? map(item.master) : null, overrides: item.overrides.map(map) };
}
