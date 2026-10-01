/**
 * Free/busy: when somebody is taken, and nothing else about it.
 *
 * A person's busy time is every event on the calendars they own - Polaris's
 * own and the ones synced from their accounts - minus what does not block:
 * a calendar marked "never show me as busy", an event marked free, a cancelled
 * one, an invitation they declined. Titles, places and attendees never leave
 * this module; the answer is intervals.
 *
 * Who may be asked about follows the people picker's rule: the reader may look
 * up exactly the accounts the directory would let them pick. Anybody else - and
 * any address with no Polaris account - is answered `unavailable`, the same way
 * for both, so the answer never says whether an account exists.
 *
 * Server-only.
 */

import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { tryItemOf } from "./objects";
import { host } from "@polaris/app-host";
import type { SessionUser } from "./access";
import { reachingWindow, verifiedAddresses } from "./occurrences";
import { loadPreferences } from "./preferences-store";
import type { FreeBusyPerson, FreeBusyView } from "./scheduling-wire";

/** Objects read per query while walking a window; every one is read. */
const PAGE_SIZE = 1000;

/** Occurrences of one recurring series taken into account per window. */
const MAX_PER_SERIES = 500;

/** Every live event on these calendars that reaches into a window, in id
 *  order, a page at a time - none is left out, so a busy room is never read as
 *  free. */
async function* objectsReaching(
    calendarIds: readonly string[],
    window: { from: Date; to: Date },
    skipUid: string | undefined
): AsyncGenerator<{ id: string; ics: string }> {
    let after: string | null = null;
    for (;;) {
        const page: { id: string; ics: string }[] = await prisma.calendarObject.findMany({
            where: {
                calendarId: { in: [...calendarIds] },
                deletedAt: null,
                component: "VEVENT",
                ...(skipUid ? { uid: { not: skipUid } } : {}),
                ...(after ? { id: { gt: after } } : {}),
                ...reachingWindow(window)
            },
            select: { id: true, ics: true },
            orderBy: { id: "asc" },
            take: PAGE_SIZE
        });
        yield* page;
        if (page.length < PAGE_SIZE) return;
        after = page[page.length - 1]!.id;
    }
}

/**
 * The busy intervals the events on these calendars make inside a window,
 * unmerged. `selfEmails` are the addresses whose declined invitations do not
 * count; `skipUid` leaves one event out (the one being placed or checked).
 */
export async function calendarBusy(
    calendarIds: readonly string[],
    window: { from: Date; to: Date },
    options: { selfEmails?: readonly string[]; skipUid?: string; floatingZone?: string } = {}
): Promise<engine.BusyInterval[]> {
    if (calendarIds.length === 0) return [];
    const calendars = await prisma.calendar.findMany({
        where: { id: { in: [...calendarIds] }, trashedAt: null, transparent: false },
        select: { id: true }
    });
    if (calendars.length === 0) return [];
    const self = new Set((options.selfEmails ?? []).map((email) => email.toLowerCase()));
    const occurrences: engine.Occurrence[] = [];
    for await (const row of objectsReaching(calendars.map((calendar) => calendar.id), window, options.skipUid)) {
        const item = tryItemOf(row.ics);
        if (!item) continue;
        try {
            for (const occurrence of engine.expandItem(item, window, {
                floatingZone: options.floatingZone ?? "UTC",
                limit: MAX_PER_SERIES
            })) {
                const declined = occurrence.event.attendees.some(
                    (attendee) => self.has(attendee.email) && attendee.partstat === "DECLINED"
                );
                if (!declined) occurrences.push(occurrence);
            }
        } catch {
            // A rule that does not expand says nothing about being busy.
        }
    }
    return engine.busyFromOccurrences(occurrences);
}

/** One person's busy time: the calendars they own, rooms and birthdays aside. */
export async function personBusy(
    person: { id: string; email: string },
    window: { from: Date; to: Date },
    floatingZone: string
): Promise<engine.BusyInterval[]> {
    const [calendars, emails] = await Promise.all([
        prisma.calendar.findMany({
            where: { ownerId: person.id, trashedAt: null, transparent: false, kind: { in: ["local", "remote"] } },
            select: { id: true }
        }),
        verifiedAddresses(person.id, person.email)
    ]);
    return engine.mergeBusy(
        await calendarBusy(
            calendars.map((calendar) => calendar.id),
            window,
            { selfEmails: emails, floatingZone }
        )
    );
}

/**
 * The stretches of a window outside somebody's working hours, in their zone.
 * A day with no hours is away all day.
 */
export function awayIntervals(
    workingHours: Readonly<Record<string, readonly { from: string; to: string }[]>>,
    window: { from: Date; to: Date },
    zone: string
): { start: Date; end: Date }[] {
    const away: { start: Date; end: Date }[] = [];
    for (const date of engine.localDays(window.from, window.to, zone)) {
        const ranges = [...(workingHours[String(engine.weekdayIndex(date))] ?? [])].sort((a, b) => (a.from < b.from ? -1 : 1));
        let cursor = 0;
        const gaps: [number, number][] = [];
        for (const range of ranges) {
            const open = engine.minutesOf(range.from);
            if (open > cursor) gaps.push([cursor, open]);
            cursor = Math.max(cursor, engine.minutesOf(range.to));
        }
        if (cursor < 1440) gaps.push([cursor, 1440]);
        for (const [from, to] of gaps) {
            const start = Math.max(engine.instantAt(date, from, zone).getTime(), window.from.getTime());
            const end = Math.min(engine.instantAt(date, to, zone).getTime(), window.to.getTime());
            if (end > start) away.push({ start: new Date(start), end: new Date(end) });
        }
    }
    return away;
}

/**
 * Which of these accounts the reader may look up: the ones the directory would
 * let them pick, and themselves. Asked of the host by id, in one question, by
 * the rule every picker uses - so nothing here re-derives who reaches whom.
 */
export async function reachablePeople(
    actor: SessionUser,
    people: readonly { id: string; email: string }[]
): Promise<Set<string>> {
    const others = people.map((person) => person.id).filter((id) => id !== actor.id);
    const allowed = new Set(others.length > 0 ? await host.calendarHost.peopleInReach({ id: actor.id, isAdmin: actor.isAdmin }, others) : []);
    if (people.some((person) => person.id === actor.id)) allowed.add(actor.id);
    return allowed;
}

/** The zone somebody's working hours are in: their own setting, or the
 *  reader's when theirs follows the browser. */
function workZone(setting: string, fallback: string): string {
    return setting !== "auto" && engine.resolveZone(setting) ? setting : fallback;
}

const iso = (interval: { start: Date; end: Date }) => ({ start: interval.start.toISOString(), end: interval.end.toISOString() });

/** Answer a free/busy question for the reader. */
export async function freeBusy(
    actor: SessionUser,
    request: {
        emails: readonly string[];
        userIds: readonly string[];
        from: Date;
        to: Date;
        zone: string;
        durationMinutes?: number;
        now?: Date;
    }
): Promise<FreeBusyView> {
    const window = { from: request.from, to: request.to };
    const [byEmail, byId] = await Promise.all([
        host.calendarHost.accountsByEmail(request.emails),
        host.calendarHost.peopleByIds(request.userIds)
    ]);
    const idOfEmail = new Map(byEmail.map((account) => [account.email, account.id]));
    const ids = [...new Set([...byEmail.map((account) => account.id), ...byId.map((person) => person.id)])];
    const people = await host.calendarHost.peopleByIds(ids);
    const personById = new Map(people.map((person) => [person.id, person]));
    const allowed = await reachablePeople(actor, people);

    const answers = new Map<string, FreeBusyPerson & { busyRaw: engine.BusyInterval[]; awayRaw: { start: Date; end: Date }[] }>();
    for (const id of ids) {
        const person = personById.get(id);
        if (!person || !allowed.has(id)) continue;
        const preferences = await loadPreferences(id);
        const busy = await personBusy(person, window, request.zone);
        const away = awayIntervals(preferences.workingHours, window, workZone(preferences.timezone, request.zone));
        answers.set(id, {
            key: id,
            name: person.name,
            status: "ok",
            busy: busy.map((interval) => ({ ...iso(interval), type: interval.type })),
            away: away.map(iso),
            busyRaw: busy,
            awayRaw: away
        });
    }

    const unavailable = (key: string, name: string): FreeBusyPerson => ({ key, name, status: "unavailable", busy: [], away: [] });
    const strip = ({ busyRaw: _busy, awayRaw: _away, ...answer }: FreeBusyPerson & { busyRaw: unknown; awayRaw: unknown }): FreeBusyPerson => answer;
    const result: FreeBusyPerson[] = [];
    for (const email of request.emails) {
        const id = idOfEmail.get(email);
        const answer = id ? answers.get(id) : undefined;
        result.push(answer ? { ...strip(answer), key: email } : unavailable(email, ""));
    }
    for (const id of request.userIds) {
        const answer = answers.get(id);
        result.push(answer ? strip(answer) : unavailable(id, ""));
    }

    let suggestions: { start: string; end: string }[] = [];
    if (request.durationMinutes && answers.size > 0) {
        const lists = [...answers.values()].map((answer) => [
            ...answer.busyRaw,
            ...answer.awayRaw.map((interval) => ({ ...interval, type: "BUSY-UNAVAILABLE" as const }))
        ]);
        suggestions = engine
            .suggestTimes({
                busy: lists,
                durationMinutes: request.durationMinutes,
                from: request.from,
                to: request.to,
                zone: request.zone,
                workingHours: null,
                stepMinutes: 15,
                limit: 12,
                now: request.now ?? new Date()
            })
            .map(iso);
    }
    return { from: request.from.toISOString(), to: request.to.toISOString(), people: result, suggestions };
}

/** Whether somebody is free right now, for a person's card: taken until when,
 *  away from work, or free until their next event. */
export async function availabilityNow(
    actor: SessionUser,
    userId: string,
    zone: string,
    now = new Date()
): Promise<{ status: "free" | "busy" | "away" | "unavailable"; until: string | null }> {
    const view = await freeBusy(actor, {
        emails: [],
        userIds: [userId],
        from: now,
        to: new Date(now.getTime() + 86_400_000),
        zone,
        now
    });
    const person = view.people[0];
    if (!person || person.status !== "ok") return { status: "unavailable", until: null };
    const at = now.getTime();
    const current = person.busy.find((interval) => Date.parse(interval.start) <= at && Date.parse(interval.end) > at);
    if (current) return { status: "busy", until: current.end };
    const away = person.away.find((interval) => Date.parse(interval.start) <= at && Date.parse(interval.end) > at);
    if (away) return { status: "away", until: away.end };
    const next = person.busy.find((interval) => Date.parse(interval.start) > at);
    return { status: "free", until: next?.start ?? null };
}
