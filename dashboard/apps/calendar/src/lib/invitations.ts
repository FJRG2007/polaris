/**
 * Invitations for events kept in Polaris's own calendars (iTIP, RFC 5546).
 *
 * Two ways somebody hears about an event they are invited to, chosen by who
 * they are rather than by a setting:
 *
 * - A Polaris account (its address, or an address it proved) gets the event in
 *   its own calendar, marked as waiting for an answer, and a `calendar.invitation`
 *   notice. Answering it there updates the organizer's copy directly.
 * - Anybody else gets an email carrying the invitation as a text/calendar part
 *   (iMIP, RFC 6047) - which their mail program shows with its own buttons - and
 *   a link to answer here, because Polaris receives no mail and a reply sent
 *   from their mail program would never arrive.
 *
 * Only the organizer's changes are sent. An attendee editing their own copy
 * changes it for themselves; an attendee's answer goes back to the organizer
 * as a reply.
 *
 * Server-only.
 */

import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { randomBytes } from "node:crypto";
import type { ObjectChange } from "./effects";
import { calendarTIn, localeOf } from "./i18n";
import { tryItemOf, writeItem, type StoredObject } from "./objects";
import { resourceIdOf } from "./resource-address";
import { loadPreferences } from "./preferences-store";
import { ensurePersonalCalendarFor } from "./personal";
import { verifiedAddresses } from "./occurrences";
import { mayMailOutside } from "./scheduling-guard";

type EventItem = Extract<engine.CalendarItem, { component: "VEVENT" }>;

/** Every component of an event item, master first. */
function eventsOf(item: engine.CalendarItem | null): engine.CalendarEvent[] {
    if (!item || item.component !== "VEVENT") return [];
    return [item.master, ...item.overrides].filter((event): event is engine.CalendarEvent => Boolean(event));
}

/** The organizer of an item, as its master (or first override) names them. */
function organizerOf(item: engine.CalendarItem | null): engine.Person | null {
    return eventsOf(item)[0]?.organizer ?? null;
}

/** Everybody invited anywhere in the item, the organizer and rooms aside. */
function inviteesOf(item: engine.CalendarItem | null): Map<string, engine.Attendee> {
    const organizer = organizerOf(item)?.email;
    const found = new Map<string, engine.Attendee>();
    for (const event of eventsOf(item)) {
        for (const attendee of event.attendees) {
            if (attendee.email === organizer || found.has(attendee.email)) continue;
            found.set(attendee.email, attendee);
        }
    }
    return found;
}

/** What makes a change worth telling the people invited: when and where it is,
 *  what it is called, whether it happens at all. */
function fingerprint(item: engine.CalendarItem | null): string {
    return JSON.stringify(
        eventsOf(item).map((event) => [
            event.recurrenceId,
            event.start,
            event.end,
            event.rule?.raw ?? null,
            event.exdates,
            event.rdates,
            event.summary,
            event.location,
            event.status,
            event.conference
        ])
    );
}

/** The sentence an answer is announced with. */
function replyKey(partstat: engine.PartStat) {
    if (partstat === "ACCEPTED") return "invitations.reply.accepted" as const;
    if (partstat === "DECLINED") return "invitations.reply.declined" as const;
    return "invitations.reply.tentative" as const;
}

function newToken(): string {
    return randomBytes(24).toString("base64url");
}

/**
 * After the organizer's calendar changed: invite who was added, tell who was
 * removed, update everybody when something they would care about changed, and
 * cancel for all when the event was deleted.
 */
export async function afterChange(change: ObjectChange, ownerId: string): Promise<void> {
    if (change.context.reply) {
        await sendReply(change, change.context.reply);
        return;
    }
    const owner = await ownerAddresses(ownerId);
    const organizer = organizerOf(change.after ?? change.before);
    // Not the organizer's copy: somebody's own copy of an invitation. Their
    // edits stay theirs.
    if (!organizer || !owner.has(organizer.email)) return;

    const before = inviteesOf(change.before);
    const after = inviteesOf(change.after);
    const changed = fingerprint(change.before) !== fingerprint(change.after);

    const removed = [...before.keys()].filter((email) => !after.has(email));
    const added = [...after.keys()].filter((email) => !before.has(email));
    const kept = [...after.keys()].filter((email) => before.has(email));

    if (change.after === null) {
        await cancelFor(change.objectId, change.before, [...before.keys()], ownerId);
        return;
    }
    if (removed.length > 0) await cancelFor(change.objectId, change.before, removed, ownerId);
    const request = [...added, ...(changed ? kept : [])];
    if (request.length > 0) await requestFor(change.objectId, change.after, request, ownerId);
}

/** The addresses an owner organizes events as. */
export async function ownerAddresses(userId: string): Promise<Set<string>> {
    const [person] = await host.calendarHost.peopleByIds([userId]);
    return new Set(await verifiedAddresses(userId, person?.email ?? ""));
}

/** Send (or deliver) the event to these invitees. */
async function requestFor(
    objectId: string,
    item: engine.CalendarItem,
    emails: readonly string[],
    organizerId: string
): Promise<void> {
    const internal = new Map(
        (await host.calendarHost.accountsByEmail(emails)).map((account) => [account.email, account.id])
    );
    const now = new Date();
    for (const email of emails) {
        const userId = internal.get(email) ?? null;
        const invitation = await prisma.calendarInvitation.upsert({
            where: { objectId_email: { objectId, email } },
            create: { objectId, email, userId, token: newToken(), sentAt: now },
            update: { userId, sentAt: now },
            select: { token: true }
        });
        const roomId = resourceIdOf(email);
        if (roomId) {
            await answerAsRoom(organizerId, roomId, item, "REQUEST");
            continue;
        }
        if (userId && userId !== organizerId) {
            await deliverInternal(userId, organizerId, item, "REQUEST");
        } else if (!userId) {
            await mailInvitation(email, item, "REQUEST", invitation.token, organizerId);
        }
    }
}

/** Tell these invitees the event, or their place in it, is gone. */
async function cancelFor(
    objectId: string,
    item: engine.CalendarItem | null,
    emails: readonly string[],
    organizerId: string
): Promise<void> {
    if (!item || emails.length === 0) return;
    const internal = new Map(
        (await host.calendarHost.accountsByEmail(emails)).map((account) => [account.email, account.id])
    );
    for (const email of emails) {
        const roomId = resourceIdOf(email);
        if (roomId) {
            await answerAsRoom(organizerId, roomId, item, "CANCEL");
            continue;
        }
        const userId = internal.get(email) ?? null;
        if (userId && userId !== organizerId) await deliverInternal(userId, organizerId, item, "CANCEL");
        else if (!userId) await mailInvitation(email, item, "CANCEL", null, organizerId);
    }
    await prisma.calendarInvitation.deleteMany({ where: { objectId, email: { in: [...emails] } } });
}

/**
 * A room or a piece of equipment is never mailed and has no inbox: it answers
 * for itself, accepting when it is free for the event and declining when it is
 * taken (see `resources.answerForRoom`). One room refusing must not stop the
 * people on the same event from hearing about it.
 */
async function answerAsRoom(
    organizerId: string,
    roomId: string,
    item: engine.CalendarItem,
    method: "REQUEST" | "CANCEL"
): Promise<void> {
    const resources = await import("./resources");
    await resources
        .answerForRoom(organizerId, roomId, item, method)
        .catch((caught: unknown) => console.error("polaris: a room did not answer an invitation:", caught));
}

const STORED_COLUMNS = {
    id: true,
    calendarId: true,
    uid: true,
    component: true,
    ics: true,
    href: true,
    etag: true,
    updatedAt: true,
    deletedAt: true
} as const;

/**
 * Somebody's copy of an event with this UID, and whether one exists at all. A
 * UID is not a secret - everybody invited and every free/busy reader sees it -
 * so a copy counts only when it was organized at one of `organizer`'s
 * addresses: the same UID under anybody else is a different event.
 */
async function copyFrom(
    userId: string,
    uid: string,
    organizer: ReadonlySet<string>,
    live: boolean
): Promise<{ copy: StoredObject | null; taken: boolean }> {
    const rows = await prisma.calendarObject.findMany({
        where: { uid, ...(live ? { deletedAt: null } : {}), calendar: { ownerId: userId, trashedAt: null } },
        select: STORED_COLUMNS
    });
    const copy = rows.find((row) => {
        const email = organizerOf(tryItemOf(row.ics))?.email;
        return email !== undefined && organizer.has(email);
    });
    return { copy: copy ?? null, taken: rows.length > 0 };
}

/**
 * Put the organizer's event into a Polaris attendee's own calendar, keeping
 * whatever they already answered and the reminders they set on their copy; or
 * mark their copy cancelled. An event of the attendee's own, or of somebody
 * else, that carries the same UID is left alone.
 */
async function deliverInternal(
    userId: string,
    organizerId: string,
    item: engine.CalendarItem,
    method: "REQUEST" | "CANCEL"
): Promise<void> {
    if (item.component !== "VEVENT") return;
    const calendarId = await invitationCalendarOf(userId);
    if (!calendarId) return;
    const { copy: existing, taken } = await copyFrom(userId, item.uid, await ownerAddresses(organizerId), false);
    if (taken && !existing) return;
    const mine = existing ? tryItemOf(existing.ics) : null;
    const emails = await ownerAddresses(userId);
    let copy: engine.CalendarItem =
        method === "CANCEL"
            ? cancelled(mine ?? item)
            : keepAnswers(item, mine, emails);
    copy = { ...copy, method: null };
    // A copy the attendee already put in the trash stays there: writing the
    // cancellation would bring it back.
    if (method === "CANCEL" && (!existing || existing.deletedAt)) return;
    await writeItem(existing?.calendarId ?? calendarId, existing ?? null, copy, {
        actor: null,
        floatingZone: "UTC",
        fromImport: true
    });
    const event = eventsOf(item)[0];
    const locale = await localeOf(userId);
    const t = calendarTIn(locale);
    const objectId = existing?.id ?? (await prisma.calendarObject.findFirst({
        where: { calendarId, uid: item.uid },
        select: { id: true }
    }))?.id;
    await host.notificationsDispatch.notify({
        userId,
        event: "calendar.invitation",
        title: method === "CANCEL" ? t("invitations.cancelledTitle", { title: event?.summary || t("invitations.untitled") }) : t("invitations.invitedTitle", { title: event?.summary || t("invitations.untitled") }),
        body: event ? whenText(event, locale, item.timezones) : null,
        href: objectId ? `/calendar/e/${objectId}` : "/calendar"
    });
}

/** The organizer's item with this attendee's own answers and alarms carried over. */
function keepAnswers(
    item: EventItem,
    mine: engine.CalendarItem | null,
    emails: ReadonlySet<string>
): engine.CalendarItem {
    const previous = new Map(eventsOf(mine).map((event) => [JSON.stringify(event.recurrenceId), event]));
    const carry = (event: engine.CalendarEvent): engine.CalendarEvent => {
        const held = previous.get(JSON.stringify(event.recurrenceId)) ?? previous.get("null");
        return {
            ...event,
            alarms: held?.alarms ?? event.alarms,
            attendees: event.attendees.map((attendee) => {
                if (!emails.has(attendee.email)) return attendee;
                const answer = held?.attendees.find((own) => own.email === attendee.email)?.partstat;
                return answer ? { ...attendee, partstat: answer } : attendee;
            })
        };
    };
    return {
        ...item,
        master: item.master ? carry(item.master) : null,
        overrides: item.overrides.map(carry)
    };
}

/** A copy marked as not happening. */
function cancelled(item: engine.CalendarItem): engine.CalendarItem {
    if (item.component !== "VEVENT") return item;
    const mark = (event: engine.CalendarEvent): engine.CalendarEvent => ({ ...event, status: "CANCELLED" });
    return { ...item, master: item.master ? mark(item.master) : null, overrides: item.overrides.map(mark) };
}

/** Where invitations land for this person: the calendar they chose, else their
 *  first own calendar (made for them if they have none yet). */
async function invitationCalendarOf(userId: string): Promise<string | null> {
    const preferences = await loadPreferences(userId);
    if (preferences.invitationCalendarId) {
        const chosen = await prisma.calendar.findFirst({
            where: { id: preferences.invitationCalendarId, ownerId: userId, trashedAt: null, readOnly: false },
            select: { id: true }
        });
        if (chosen) return chosen.id;
    }
    return ensurePersonalCalendarFor(userId);
}

/** One line saying when an event is, in a locale. */
function whenText(event: engine.CalendarEvent, locale: string, timezones: readonly string[]): string {
    const start = engine.valueToInstant(event.start, "UTC", timezones);
    const zone = "tzid" in event.start && event.start.tzid ? engine.resolveZone(event.start.tzid) ?? "UTC" : "UTC";
    // Intl refuses timeZoneName next to dateStyle/timeStyle, so the timed form
    // names its parts one by one.
    const format =
        "date" in event.start
            ? new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" })
            : new Intl.DateTimeFormat(locale, {
                  weekday: "long",
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: zone,
                  timeZoneName: "short"
              });
    return format.format(start);
}

/** Mail an invitation (or its cancellation) to somebody outside Polaris. */
async function mailInvitation(
    email: string,
    item: engine.CalendarItem,
    method: "REQUEST" | "CANCEL",
    token: string | null,
    organizerId: string
): Promise<void> {
    const event = eventsOf(item)[0];
    if (!event) return;
    if (!(await mayMailOutside(organizerId))) {
        console.error("polaris: a calendar invitation was not sent: the organizer's mail limit is spent");
        return;
    }
    const locale = await localeOf(organizerId);
    const t = calendarTIn(locale);
    const title = event.summary || t("invitations.untitled");
    const when = whenText(event, locale, item.timezones);
    const base = await host.domainService.appBaseUrl();
    const answer = token ? `${base}/cal/rsvp/${token}` : null;
    const organizer = event.organizer?.name || event.organizer?.email || "";
    const lines = [
        method === "CANCEL" ? t("invitations.mailCancelled", { organizer }) : t("invitations.mailInvited", { organizer }),
        "",
        title,
        when,
        ...(event.location ? [event.location] : []),
        ...(event.conference ? [event.conference] : []),
        ...(answer ? ["", t("invitations.mailAnswer"), answer] : [])
    ];
    const ics = engine.buildItip(item, method, method === "CANCEL" ? { attendeeEmail: email } : {});
    const result = await host.calendarHost.sendCalendarEmail({
        to: email,
        subject:
            method === "CANCEL"
                ? t("invitations.cancelledSubject", { title })
                : t("invitations.invitedSubject", { title, when }),
        text: `${lines.join("\n")}\n`,
        calendar: { method, ics }
    });
    if (result.error) console.error("polaris: a calendar invitation was not sent:", result.error);
}

/**
 * An attendee answered on their own copy: carry the answer to the organizer -
 * their copy directly when they are a Polaris account, a REPLY email when not.
 */
async function sendReply(
    change: ObjectChange,
    reply: { email: string; partstat: engine.PartStat; recurrenceKey: string | null }
): Promise<void> {
    const item = change.after;
    const organizer = organizerOf(item);
    if (!item || !organizer) return;
    const [account] = await host.calendarHost.accountsByEmail([organizer.email]);
    if (account) {
        await applyAnswer(account.id, item.uid, reply.email, reply.partstat, reply.recurrenceKey);
        return;
    }
    const ics = engine.buildItip(item, "REPLY", {
        attendeeEmail: reply.email,
        partstat: reply.partstat,
        ...(reply.recurrenceKey ? { recurrenceKey: reply.recurrenceKey } : {})
    });
    const event = eventsOf(item)[0];
    const locale = change.context.actor ? await localeOf(change.context.actor.id) : "en-US";
    const t = calendarTIn(locale as never);
    await host.calendarHost.sendCalendarEmail({
        to: organizer.email,
        subject: t(replyKey(reply.partstat), {
            who: reply.email,
            title: event?.summary || t("invitations.untitled")
        }),
        text: `${reply.email}\n`,
        calendar: { method: "REPLY", ics }
    });
}

/**
 * Record an attendee's answer on the organizer's copy (a Polaris organizer),
 * and tell the organizer. Also what an answer through the public link does.
 */
export async function applyAnswer(
    organizerId: string,
    uid: string,
    email: string,
    partstat: engine.PartStat,
    recurrenceKey: string | null
): Promise<void> {
    const { copy: row } = await copyFrom(organizerId, uid, await ownerAddresses(organizerId), true);
    const item = row ? tryItemOf(row.ics) : null;
    if (!row || !item || !eventsOf(item).some((event) => event.attendees.some((attendee) => attendee.email === email))) return;
    const answered = engine.applyReply(item, email, partstat, recurrenceKey);
    await writeItem(row.calendarId, row, answered, { actor: null, floatingZone: "UTC", fromImport: true });
    await prisma.calendarInvitation.updateMany({
        where: { objectId: row.id, email },
        data: { partstat, respondedAt: new Date() }
    });
    const event = eventsOf(item)[0];
    const t = calendarTIn(await localeOf(organizerId));
    await host.notificationsDispatch.notify({
        userId: organizerId,
        event: "calendar.reply",
        title: t(replyKey(partstat), {
            who: email,
            title: event?.summary || t("invitations.untitled")
        }),
        href: `/calendar/e/${row.id}`
    });
}

/** An invitation by its public token, for the answer page. */
export async function invitationByToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return prisma.calendarInvitation.findUnique({
        where: { token },
        select: {
            id: true,
            email: true,
            partstat: true,
            objectId: true,
            object: { select: { uid: true, ics: true, deletedAt: true, calendar: { select: { ownerId: true } } } }
        }
    });
}
