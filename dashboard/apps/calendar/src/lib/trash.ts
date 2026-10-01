/**
 * The trash: calendars and events deleted in the last 30 days, restored or
 * removed for good. Only what the person owns, or deleted from a calendar they
 * may write to - a sharee who deleted an event can take it back.
 *
 * An event deleted from a provider calendar is already gone from the provider;
 * restoring it writes it back there as a new event.
 *
 * Server-only.
 */

import { calendarT } from "./i18n";
import { prisma } from "@polaris/db";
import { CalendarRefusal } from "./errors";
import type { TrashItemView } from "./wire";
import { tryItemOf, writeItem, type StoredObject } from "./objects";
import { reachableCalendars, reaches, type SessionUser } from "./access";

export const RETENTION_DAYS = 30;
const DAY = 86_400_000;

function purgeAt(deletedAt: Date): string {
    return new Date(deletedAt.getTime() + RETENTION_DAYS * DAY).toISOString();
}

/** What this person may see in the trash, newest first. */
export async function listTrash(user: SessionUser): Promise<TrashItemView[]> {
    const reach = await reachableCalendars(user.id);
    const writable = [...reach.entries()].filter(([, level]) => reaches(level, "write")).map(([id]) => id);
    const [calendars, objects] = await Promise.all([
        prisma.calendar.findMany({
            where: { ownerId: user.id, trashedAt: { not: null } },
            select: { id: true, name: true, color: true, trashedAt: true },
            orderBy: { trashedAt: "desc" },
            take: 500
        }),
        prisma.calendarObject.findMany({
            where: { calendarId: { in: writable }, deletedAt: { not: null }, calendar: { trashedAt: null } },
            select: {
                id: true,
                summary: true,
                deletedAt: true,
                calendar: { select: { name: true, color: true } }
            },
            orderBy: { deletedAt: "desc" },
            take: 1000
        })
    ]);
    const t = await calendarT();
    return [
        ...calendars.map((calendar) => ({
            kind: "calendar" as const,
            id: calendar.id,
            title: calendar.name,
            calendarName: calendar.name,
            color: calendar.color,
            deletedAt: calendar.trashedAt!.toISOString(),
            purgeAt: purgeAt(calendar.trashedAt!)
        })),
        ...objects.map((object) => ({
            kind: "event" as const,
            id: object.id,
            title: object.summary || t("trash.untitled"),
            calendarName: object.calendar.name,
            color: object.calendar.color,
            deletedAt: object.deletedAt!.toISOString(),
            purgeAt: purgeAt(object.deletedAt!)
        }))
    ].sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

/** A trashed event this person may act on. */
async function trashedObject(user: SessionUser, id: string): Promise<StoredObject> {
    const row = await prisma.calendarObject.findUnique({
        where: { id },
        select: {
            id: true,
            calendarId: true,
            uid: true,
            component: true,
            ics: true,
            href: true,
            etag: true,
            updatedAt: true,
            deletedAt: true
        }
    });
    const reach = row ? ((await reachableCalendars(user.id)).get(row.calendarId) ?? null) : null;
    if (!row || !row.deletedAt || !reaches(reach, "write")) {
        throw new CalendarRefusal((await calendarT())("errors.eventNotFound"));
    }
    return row;
}

/** A trashed calendar of this person's own. */
async function trashedCalendar(user: SessionUser, id: string) {
    const row = await prisma.calendar.findFirst({
        where: { id, ownerId: user.id, trashedAt: { not: null } },
        select: { id: true }
    });
    if (!row) throw new CalendarRefusal((await calendarT())("errors.calendarNotFound"));
    return row;
}

/** Take something out of the trash. A restored event is written again - to its
 *  provider too, as new, since the provider forgot it when it was deleted. */
export async function restoreTrash(
    user: SessionUser,
    kind: "calendar" | "event",
    id: string,
    floatingZone: string
): Promise<void> {
    if (kind === "calendar") {
        const calendar = await trashedCalendar(user, id);
        await prisma.calendar.update({ where: { id: calendar.id }, data: { trashedAt: null } });
        // Putting it in the trash cleared its reminders; its events remind again.
        const row = await prisma.calendar.findUniqueOrThrow({ where: { id: calendar.id }, select: { alarmsMuted: true } });
        if (row.alarmsMuted) return;
        const live = await prisma.calendarObject.findMany({ where: { calendarId: calendar.id, deletedAt: null }, select: { id: true, ics: true } });
        const reminders = await import("./reminders");
        for (const object of live) await reminders.planObject(object.id, tryItemOf(object.ics));
        return;
    }
    const row = await trashedObject(user, id);
    const item = tryItemOf(row.ics);
    if (!item) throw new CalendarRefusal((await calendarT())("errors.unreadableEvent"));
    await prisma.calendarObject.update({ where: { id: row.id }, data: { href: "", etag: "" } });
    await writeItem(row.calendarId, { ...row, href: "", etag: "" }, item, { actor: user, floatingZone });
}

/** Remove something for good. */
export async function purgeTrash(user: SessionUser, kind: "calendar" | "event", id: string): Promise<void> {
    if (kind === "calendar") {
        const calendar = await trashedCalendar(user, id);
        await prisma.calendar.delete({ where: { id: calendar.id } });
        return;
    }
    const row = await trashedObject(user, id);
    await prisma.calendarObject.delete({ where: { id: row.id } });
}

/** Empty everything this person may see in the trash. */
export async function emptyTrash(user: SessionUser): Promise<number> {
    const items = await listTrash(user);
    const calendars = items.filter((item) => item.kind === "calendar").map((item) => item.id);
    const objects = items.filter((item) => item.kind === "event").map((item) => item.id);
    const [removedCalendars, removedObjects] = await prisma.$transaction([
        prisma.calendar.deleteMany({
            where: { id: { in: calendars }, ownerId: user.id, trashedAt: { not: null } }
        }),
        prisma.calendarObject.deleteMany({ where: { id: { in: objects }, deletedAt: { not: null } } })
    ]);
    return removedCalendars.count + removedObjects.count;
}

/** Remove for good whatever has been in the trash longer than the retention -
 *  every account's, from the housekeeping job. */
export async function purgeExpiredTrash(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
    const [calendars, objects] = await prisma.$transaction([
        prisma.calendar.deleteMany({ where: { trashedAt: { lt: cutoff } } }),
        prisma.calendarObject.deleteMany({ where: { deletedAt: { lt: cutoff } } })
    ]);
    return calendars.count + objects.count;
}
