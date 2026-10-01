/**
 * Reminders: when each alarm of each event fires next, and firing the ones that
 * are due.
 *
 * Only the next firing of each alarm is stored (`CalendarReminder`), per person
 * who should hear it - the calendar's owner and everybody it is shared with to
 * read or more. Firing one plans the next occurrence's, so a weekly meeting
 * never stores more than one row per alarm. Editing an event re-plans it from
 * scratch; deleting it (or muting its calendar) clears it.
 *
 * A notification alarm arrives the way every Polaris alert does - the bell, the
 * browser, whatever routes the person set up for `calendar.reminder`. An email
 * alarm is mailed whatever those rules say: asking for an email is the rule.
 *
 * Server-only.
 */

import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { tryItemOf } from "./objects";
import { host } from "@polaris/app-host";
import { calendarTIn, localeOf } from "./i18n";
import { forReader, publicItem, reachOf, reaches, type Reach } from "./access";

/** How many people one calendar reminds at most - its owner and its sharees. */
const MAX_RECIPIENTS = 200;

/** A reminder due longer ago than this - the server was down through it - is
 *  dropped rather than sent: "your meeting started yesterday" helps nobody. */
const STALE_MS = 6 * 60 * 60 * 1000;

/** Rows handled per pass. The next pass takes the rest a minute later. */
const BATCH = 500;

/** Who hears a calendar's alarms: its owner and everybody who reads it. */
async function recipientsOf(calendarId: string): Promise<string[]> {
    const calendar = await prisma.calendar.findUnique({
        where: { id: calendarId },
        select: {
            ownerId: true,
            kind: true,
            shares: { where: { access: { in: ["read", "write", "manage"] } }, select: { userId: true, teamId: true } }
        }
    });
    if (!calendar || calendar.kind === "resource") return [];
    const people = new Set<string>([calendar.ownerId]);
    for (const share of calendar.shares) {
        if (share.userId) people.add(share.userId);
        if (share.teamId) for (const member of await host.calendarHost.teamMemberIds(share.teamId)) people.add(member);
        if (people.size >= MAX_RECIPIENTS) break;
    }
    const muted = await prisma.calendarDisplay.findMany({
        where: { calendarId, hidden: true, userId: { in: [...people] } },
        select: { userId: true }
    });
    for (const row of muted) people.delete(row.userId);
    return [...people].slice(0, MAX_RECIPIENTS);
}

/** Stop reminding these people of a calendar's events. */
export async function forgetReminders(calendarId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    await prisma.calendarReminder.deleteMany({ where: { userId: { in: [...userIds] }, object: { calendarId } } });
}

/** The zone a floating time is read in when nobody is asking: the calendar's. */
async function floatingZoneOf(calendarId: string): Promise<string> {
    const calendar = await prisma.calendar.findUnique({ where: { id: calendarId }, select: { timezone: true } });
    return calendar?.timezone || "UTC";
}

/**
 * Plan an object's reminders again from its current text. `item` null clears
 * them (deleted, trashed, or its calendar's alarms muted).
 */
export async function planObject(objectId: string, item: engine.CalendarItem | null, now = new Date()): Promise<void> {
    await prisma.calendarReminder.deleteMany({ where: { objectId } });
    if (!item) return;
    const row = await prisma.calendarObject.findUnique({ where: { id: objectId }, select: { calendarId: true } });
    if (!row) return;
    const planned = engine.nextAlarm(item, now, await floatingZoneOf(row.calendarId));
    if (planned.length === 0) return;
    const people = await recipientsOf(row.calendarId);
    const rows = people.flatMap((userId) =>
        planned.map((alarm) => ({
            objectId,
            userId,
            fireAt: alarm.fireAt,
            occurrence: alarm.occurrenceStart,
            alarmKey: alarm.key,
            action: alarm.action === "EMAIL" ? "EMAIL" : "DISPLAY"
        }))
    );
    if (rows.length > 0) await prisma.calendarReminder.createMany({ data: rows, skipDuplicates: true });
}

/** Send what is due, and plan each alarm's next firing. */
export async function fireDueReminders(now = new Date()): Promise<{ sent: number; dropped: number }> {
    const due = await prisma.calendarReminder.findMany({
        where: { fireAt: { lte: now } },
        orderBy: { fireAt: "asc" },
        take: BATCH,
        select: {
            id: true,
            objectId: true,
            userId: true,
            fireAt: true,
            occurrence: true,
            alarmKey: true,
            action: true,
            object: {
                select: {
                    calendarId: true,
                    ics: true,
                    deletedAt: true,
                    calendar: { select: { ownerId: true, kind: true, name: true, alarmsMuted: true, trashedAt: true, timezone: true } }
                }
            }
        }
    });
    let sent = 0;
    let dropped = 0;
    const replan = new Set<string>();
    const levels = new Map<string, Reach | null>();
    for (const reminder of due) {
        // Claimed before anything is sent: a pass that dies half way must not
        // send this one again on the next.
        const claimed = await prisma.calendarReminder.deleteMany({ where: { id: reminder.id } });
        if (claimed.count === 0) continue;
        const object = reminder.object;
        if (object.deletedAt || object.calendar.alarmsMuted || object.calendar.trashedAt) continue;
        replan.add(reminder.objectId);
        if (now.getTime() - reminder.fireAt.getTime() > STALE_MS) {
            dropped += 1;
            continue;
        }
        const item = tryItemOf(object.ics);
        if (!item) continue;
        const calendar = { id: object.calendarId, ...object.calendar };
        const key = `${reminder.userId}:${calendar.id}`;
        if (!levels.has(key)) levels.set(key, (await reachOf(reminder.userId, [calendar])).get(calendar.id) ?? null);
        await deliver(reminder.userId, reminder.action, item, reminder.occurrence, reminder.objectId, calendar, levels.get(key)!)
            .then((delivered) => {
                if (delivered) sent += 1;
            })
            .catch((caught: unknown) => console.error("polaris: a calendar reminder could not be sent:", caught));
    }
    // The next firing of every alarm that just fired, from after this one -
    // once nothing is left due for the object, since planning it again drops
    // the rows this pass had no room for.
    const unsent = await prisma.calendarReminder.findMany({
        where: { objectId: { in: [...replan] }, fireAt: { lte: now } },
        select: { objectId: true }
    });
    for (const row of unsent) replan.delete(row.objectId);
    for (const objectId of replan) {
        const row = await prisma.calendarObject.findUnique({
            where: { id: objectId },
            select: { ics: true, deletedAt: true }
        });
        if (!row || row.deletedAt) continue;
        await planObject(objectId, tryItemOf(row.ics), new Date(now.getTime() + 1000));
    }
    return { sent, dropped };
}

/**
 * What the event is called, and when, in the reader's words - and in the
 * event's own zone (the calendar's for a floating or all-day one, the zone the
 * reminder was planned in), named, rather than the server's.
 */
async function describe(
    userId: string,
    item: engine.CalendarItem,
    occurrence: Date,
    calendarZone: string,
    busyOnly: boolean
): Promise<{ title: string; body: string; locale: string }> {
    const locale = await localeOf(userId);
    const t = calendarTIn(locale);
    const summary = busyOnly
        ? t("published.busy")
        : item.component === "VEVENT"
            ? (item.master ?? item.overrides[0])?.summary || t("reminders.untitledEvent")
            : item.todo.summary || t("reminders.untitledTask");
    const start = item.component === "VEVENT" ? (item.master ?? item.overrides[0])?.start : (item.todo.due ?? item.todo.start);
    const allDay = Boolean(start && "date" in start);
    const zone = (start && "tzid" in start && start.tzid && engine.resolveZone(start.tzid)) || calendarZone;
    const when = new Intl.DateTimeFormat(
        locale,
        allDay
            ? { dateStyle: "full", timeZone: zone }
            : { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone, timeZoneName: "short" }
    ).format(occurrence);
    return { title: summary, body: t("reminders.body", { when }), locale };
}

async function deliver(
    userId: string,
    action: string,
    item: engine.CalendarItem,
    occurrence: Date,
    objectId: string,
    calendar: { name: string; timezone: string },
    level: Reach | null
): Promise<boolean> {
    if (!reaches(level, "read")) return false;
    const full = reaches(level, "write");
    const shown = full ? item : forReader(item);
    if (!shown) return false;
    const busyOnly = !full && !publicItem(shown);
    const words = await describe(userId, shown, occurrence, calendar.timezone || "UTC", busyOnly);
    const href = `/calendar/e/${objectId}`;
    if (action === "EMAIL") {
        const person = (await host.calendarHost.peopleByIds([userId]))[0];
        if (!person?.email) return false;
        const t = calendarTIn(words.locale as never);
        const result = await host.calendarHost.sendCalendarEmail({
            to: person.email,
            subject: t("reminders.mailSubject", { title: words.title }),
            text: `${words.title}\n${words.body}\n${t("reminders.mailCalendar", { calendar: calendar.name })}\n`
        });
        if (result.error) throw new Error(result.error);
        return true;
    }
    await host.notificationsDispatch.notify({
        userId,
        event: "calendar.reminder",
        title: words.title,
        body: words.body,
        href
    });
    return true;
}
