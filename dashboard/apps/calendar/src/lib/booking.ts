/**
 * Booking pages (Nextcloud's appointments, Google's appointment schedules): a
 * page with an address where people outside Polaris pick a time with somebody.
 *
 * A visitor never sees the owner's calendars. They are offered slots - the
 * page's weekly hours and date overrides, less minimum notice, horizon, per-day
 * cap, buffers, the busy time of the booking calendar and the conflict
 * calendars, and the other bookings - and a slot they pick is held for them
 * until they confirm their address from the email this sends. A hold nobody
 * confirms is dropped after an hour by `sweepStaleBookings`.
 *
 * Confirming checks the slot again (somebody may have taken it since), then
 * writes the event into the booking calendar through `writeItem` with the
 * visitor as its attendee - so the ordinary invitation path mails them the
 * event - and tells the owner. The visitor's manage link cancels or moves it.
 *
 * Server-only.
 */

import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { calendarBusy } from "./freebusy";
import { CalendarRefusal } from "./errors";
import type { SessionUser } from "./access";
import { readInstanceSettings } from "./instance-settings";
import { calendarT, calendarTFor, calendarTIn, localeOf } from "./i18n";
import { callerAddress, newLinkToken, throttle } from "./scheduling-guard";
import { itemOf, trashObject, writeItem, type StoredObject } from "./objects";
import { requireCalendar, requireWritableCalendar, reachOf, reaches } from "./access";
import {
    answersSchemaFor,
    questionSchema,
    slugSchema,
    type BookingPageInput,
    type BookingQuestion,
    type BookingRequest
} from "./scheduling-schemas";
import type { BookingPageView, BookingView, ManagedBooking, PublicBookingPage, SlotView } from "./scheduling-wire";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** How long an unconfirmed booking holds its slot. */
export const HOLD_MS = HOUR;

/** Pages one person may keep. */
const MAX_PAGES = 50;

/** The widest window the public page asks slots for at once. */
export const MAX_SLOT_WINDOW_DAYS = 42;

/** Where a visitor's own note is kept among the answers: a key no question id
 *  can be (they are lowercase letters and digits). */
const NOTE_KEY = "_note";

const OBJECT_COLUMNS = {
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

type PageRow = Awaited<ReturnType<typeof prisma.calendarBookingPage.findUniqueOrThrow>>;

const CLOSED: engine.Availability = {
    weekly: { "0": [], "1": [], "2": [], "3": [], "4": [], "5": [], "6": [] },
    overrides: {}
};

function readAvailability(raw: string): engine.Availability {
    try {
        const parsed = engine.availabilitySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : CLOSED;
    } catch {
        return CLOSED;
    }
}

function readQuestions(raw: string): BookingQuestion[] {
    try {
        const list = JSON.parse(raw) as unknown;
        if (!Array.isArray(list)) return [];
        return list.flatMap((entry) => {
            const parsed = questionSchema.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
        });
    } catch {
        return [];
    }
}

function readIds(raw: string): string[] {
    try {
        const list = JSON.parse(raw) as unknown;
        return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

function readAnswers(raw: string): Record<string, string> {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return {};
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
        return {};
    }
}

function pageView(row: PageRow, upcoming: number): BookingPageView {
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        description: row.description,
        location: row.location,
        visibility: row.visibility === "public" ? "public" : "link",
        calendarId: row.calendarId,
        conflictIds: readIds(row.conflictIds),
        durationMinutes: row.durationMinutes,
        slotMinutes: row.slotMinutes,
        bufferBefore: row.bufferBefore,
        bufferAfter: row.bufferAfter,
        noticeMinutes: row.noticeMinutes,
        maxPerDay: row.maxPerDay,
        horizonDays: row.horizonDays,
        timezone: row.timezone,
        availability: readAvailability(row.availability),
        questions: readQuestions(row.questions),
        meetingLink: row.meetingLink,
        enabled: row.enabled,
        upcoming
    };
}

async function publicView(row: PageRow): Promise<PublicBookingPage> {
    const [owner] = await host.calendarHost.peopleByIds([row.ownerId]);
    return {
        slug: row.slug,
        title: row.title,
        description: row.description,
        location: row.location,
        durationMinutes: row.durationMinutes,
        timezone: row.timezone,
        horizonDays: row.horizonDays,
        questions: readQuestions(row.questions),
        ownerName: owner?.name ?? ""
    };
}

// ---------------------------------------------------------------- the owner's side

async function upcomingCounts(pageIds: readonly string[], now: Date): Promise<Map<string, number>> {
    if (pageIds.length === 0) return new Map();
    const rows = await prisma.calendarBooking.groupBy({
        by: ["pageId"],
        where: { pageId: { in: [...pageIds] }, status: "confirmed", start: { gte: now } },
        _count: { _all: true }
    });
    return new Map(rows.map((row) => [row.pageId, row._count._all]));
}

export async function listBookingPages(user: SessionUser, now = new Date()): Promise<BookingPageView[]> {
    const rows = await prisma.calendarBookingPage.findMany({ where: { ownerId: user.id }, orderBy: { createdAt: "asc" } });
    const counts = await upcomingCounts(
        rows.map((row) => row.id),
        now
    );
    return rows.map((row) => pageView(row, counts.get(row.id) ?? 0));
}

async function ownPage(user: SessionUser, id: string): Promise<PageRow> {
    const row = await prisma.calendarBookingPage.findFirst({ where: { id, ownerId: user.id } });
    if (!row) throw new CalendarRefusal((await calendarT())("bookingPage.notFound"));
    return row;
}

export async function bookingPage(user: SessionUser, id: string, now = new Date()): Promise<BookingPageView> {
    const row = await ownPage(user, id);
    return pageView(row, (await upcomingCounts([row.id], now)).get(row.id) ?? 0);
}

/** A readable address for a new page: its title in lowercase ASCII and a short
 *  random tail, so two "Consultation" pages never collide. */
function newSlug(title: string): string {
    const base = title
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/, "");
    const tail = newLinkToken().replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6).padEnd(6, "0");
    const slug = base ? `${base}-${tail}` : `book-${tail}`;
    return slugSchema.safeParse(slug).success ? slug : `book-${tail}`;
}

/** The calendars a page names must be the owner's to use: the booking calendar
 *  writable, each conflict calendar at least readable as busy time. */
async function checkCalendars(user: SessionUser, input: BookingPageInput): Promise<void> {
    await requireWritableCalendar(user.id, input.calendarId);
    for (const id of input.conflictIds) await requireCalendar(user.id, id, "freebusy");
}

function columns(input: BookingPageInput) {
    return {
        title: input.title,
        description: input.description,
        location: input.location,
        visibility: input.visibility,
        calendarId: input.calendarId,
        conflictIds: JSON.stringify([...new Set(input.conflictIds.filter((id) => id !== input.calendarId))]),
        durationMinutes: input.durationMinutes,
        slotMinutes: input.slotMinutes,
        bufferBefore: input.bufferBefore,
        bufferAfter: input.bufferAfter,
        noticeMinutes: input.noticeMinutes,
        maxPerDay: input.maxPerDay,
        horizonDays: input.horizonDays,
        timezone: input.timezone,
        availability: JSON.stringify(input.availability),
        questions: JSON.stringify(input.questions),
        meetingLink: input.meetingLink,
        enabled: input.enabled
    };
}

/** Booking pages are an instance-wide switch: while the operator has them off,
 *  nobody makes one or turns one on. */
async function bookingAllowed(): Promise<boolean> {
    return (await readInstanceSettings()).allowBooking;
}

async function requireBookingAllowed(): Promise<void> {
    if (!(await bookingAllowed())) throw new CalendarRefusal((await calendarT())("instance.bookingOff"));
}

async function slugFree(slug: string, exceptId: string | null): Promise<void> {
    const taken = await prisma.calendarBookingPage.findUnique({ where: { slug }, select: { id: true } });
    if (taken && taken.id !== exceptId) throw new CalendarRefusal((await calendarT())("bookingPage.slugTaken"));
}

export async function createBookingPage(user: SessionUser, input: BookingPageInput): Promise<BookingPageView> {
    await requireBookingAllowed();
    const count = await prisma.calendarBookingPage.count({ where: { ownerId: user.id } });
    if (count >= MAX_PAGES) throw new CalendarRefusal((await calendarT())("bookingPage.tooMany"));
    await checkCalendars(user, input);
    const slug = input.slug ?? newSlug(input.title);
    await slugFree(slug, null);
    const row = await prisma.calendarBookingPage.create({ data: { ownerId: user.id, slug, ...columns(input) } });
    return pageView(row, 0);
}

export async function updateBookingPage(user: SessionUser, id: string, input: BookingPageInput): Promise<BookingPageView> {
    const row = await ownPage(user, id);
    if (input.enabled) await requireBookingAllowed();
    await checkCalendars(user, input);
    const slug = input.slug ?? row.slug;
    if (slug !== row.slug) await slugFree(slug, row.id);
    const updated = await prisma.calendarBookingPage.update({ where: { id: row.id }, data: { slug, ...columns(input) } });
    return pageView(updated, (await upcomingCounts([row.id], new Date())).get(row.id) ?? 0);
}

/** A copy of a page, switched off until its owner has looked at it. */
export async function duplicateBookingPage(user: SessionUser, id: string): Promise<BookingPageView> {
    await requireBookingAllowed();
    const row = await ownPage(user, id);
    const count = await prisma.calendarBookingPage.count({ where: { ownerId: user.id } });
    if (count >= MAX_PAGES) throw new CalendarRefusal((await calendarT())("bookingPage.tooMany"));
    const t = await calendarT();
    const title = t("bookingPage.copyOf", { title: row.title }).slice(0, 120);
    const {
        id: _id,
        slug: _slug,
        createdAt: _created,
        updatedAt: _updated,
        ownerId: _owner,
        title: _title,
        enabled: _enabled,
        ...rest
    } = row;
    const copy = await prisma.calendarBookingPage.create({
        data: { ...rest, ownerId: user.id, title, slug: newSlug(title), enabled: false }
    });
    return pageView(copy, 0);
}

/** Delete a page. Bookings already confirmed stay in the calendar as events. */
export async function deleteBookingPage(user: SessionUser, id: string): Promise<void> {
    const row = await ownPage(user, id);
    await prisma.calendarBookingPage.delete({ where: { id: row.id } });
}

export async function listBookings(user: SessionUser, pageId: string): Promise<BookingView[]> {
    const page = await ownPage(user, pageId);
    const questions = readQuestions(page.questions);
    const rows = await prisma.calendarBooking.findMany({
        where: { pageId: page.id },
        orderBy: { start: "desc" },
        take: 500
    });
    const t = await calendarT();
    return rows.map((row) => {
        const answers = readAnswers(row.answers);
        return {
            id: row.id,
            name: row.name,
            email: row.email,
            start: row.start.toISOString(),
            end: row.end.toISOString(),
            status: row.status === "confirmed" ? "confirmed" : row.status === "cancelled" ? "cancelled" : "pending",
            timezone: row.timezone,
            answers: [
                ...questions.flatMap((question) =>
                    answers[question.id] ? [{ label: question.label, value: answers[question.id]! }] : []
                ),
                ...(answers[NOTE_KEY] ? [{ label: t("booking.note"), value: answers[NOTE_KEY] }] : [])
            ],
            objectId: row.objectId,
            createdAt: row.createdAt.toISOString()
        };
    });
}

// ---------------------------------------------------------------- slots

/** Bookings that hold time: confirmed ones, and holds younger than `HOLD_MS`. */
function holdingWhere(now: Date) {
    return { OR: [{ status: "confirmed" }, { status: "pending", createdAt: { gt: new Date(now.getTime() - HOLD_MS) } }] };
}

type SlotIgnore = { bookingId?: string; uid?: string; holdsBefore?: Date };

type Client = Pick<typeof prisma, "calendarBooking" | "calendarBookingPage">;

/**
 * The slots a page offers inside a window. `ignore` leaves out one booking and
 * its event - the one being confirmed or moved, which must not block itself;
 * `holdsBefore` counts only holds made before that instant, so of two visitors
 * who raced for one slot the first to ask keeps it.
 */
async function slotsFor(
    page: PageRow,
    window: { from: Date; to: Date },
    now: Date,
    ignore: SlotIgnore = {}
): Promise<{ start: Date; end: Date }[]> {
    return slotsAmong(page, window, now, await busyFor(page, window, ignore), await holdsFor(prisma, page, window, now, ignore));
}

function paddedWindow(window: { from: Date; to: Date }): { from: Date; to: Date } {
    return { from: new Date(window.from.getTime() - DAY), to: new Date(window.to.getTime() + DAY) };
}

/** The owner's busy time on the booking calendar and the conflict calendars. */
async function busyFor(page: PageRow, window: { from: Date; to: Date }, ignore: SlotIgnore) {
    const padded = paddedWindow(window);
    const conflictIds = readIds(page.conflictIds);
    const candidates = await prisma.calendar.findMany({
        where: { id: { in: [page.calendarId, ...conflictIds] }, trashedAt: null },
        select: { id: true, ownerId: true, kind: true, trashedAt: true }
    });
    // A calendar the owner no longer reaches says nothing about them any more.
    const reach = await reachOf(page.ownerId, candidates);
    const calendarIds = candidates.filter((calendar) => reaches(reach.get(calendar.id) ?? null, "freebusy")).map((calendar) => calendar.id);
    const [owner] = await host.calendarHost.peopleByIds([page.ownerId]);
    return calendarBusy(calendarIds, padded, {
        selfEmails: owner ? [owner.email] : [],
        floatingZone: page.timezone,
        ...(ignore.uid ? { skipUid: ignore.uid } : {})
    });
}

/** The other bookings on the page that hold time around the window. */
async function holdsFor(client: Client, page: PageRow, window: { from: Date; to: Date }, now: Date, ignore: SlotIgnore) {
    const padded = paddedWindow(window);
    const holding = await client.calendarBooking.findMany({
        where: {
            pageId: page.id,
            start: { lt: padded.to },
            end: { gt: padded.from },
            ...holdingWhere(now),
            ...(ignore.bookingId ? { id: { not: ignore.bookingId } } : {})
        },
        select: { start: true, end: true, status: true, createdAt: true }
    });
    return holding.filter(
        (booking) => booking.status === "confirmed" || !ignore.holdsBefore || booking.createdAt < ignore.holdsBefore
    );
}

function slotsAmong(
    page: PageRow,
    window: { from: Date; to: Date },
    now: Date,
    busy: Awaited<ReturnType<typeof busyFor>>,
    bookings: Awaited<ReturnType<typeof holdsFor>>
): { start: Date; end: Date }[] {
    return engine.bookingSlots({
        durationMinutes: page.durationMinutes,
        slotMinutes: page.slotMinutes,
        bufferBefore: page.bufferBefore,
        bufferAfter: page.bufferAfter,
        noticeMinutes: page.noticeMinutes,
        maxPerDay: page.maxPerDay,
        horizonDays: page.horizonDays,
        timezone: page.timezone,
        availability: readAvailability(page.availability),
        busy,
        bookings,
        now,
        from: window.from,
        to: window.to
    });
}

async function openPage(slug: string): Promise<PageRow | null> {
    if (!slugSchema.safeParse(slug).success) return null;
    const row = await prisma.calendarBookingPage.findUnique({ where: { slug } });
    if (!row || !row.enabled) return null;
    // Switched off for the whole instance: every public surface finds no page.
    return (await bookingAllowed()) ? row : null;
}

/** A page as a visitor sees it, or null when there is none or it is off. */
export async function publicBookingPage(slug: string): Promise<PublicBookingPage | null> {
    const row = await openPage(slug);
    return row ? publicView(row) : null;
}

/** The slots a visitor may pick inside a window. */
export async function publicSlots(slug: string, window: { from: Date; to: Date }, now = new Date()): Promise<SlotView[] | null> {
    const row = await openPage(slug);
    if (!row) return null;
    const slots = await slotsFor(row, window, now);
    return slots.map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() }));
}

/**
 * Run `write` if the slot starting at `start` is offered, as the given
 * exceptions see it, with every other booking write on the page held back until
 * it is done: two visitors, or a visitor and a move, reaching for one slot at
 * once cannot both get it. Answers null when the slot is not offered.
 */
async function claimSlot<T>(
    page: PageRow,
    start: Date,
    now: Date,
    ignore: SlotIgnore,
    write: (client: Client) => Promise<T>
): Promise<T | null> {
    const window = { from: start, to: new Date(start.getTime() + page.durationMinutes * 60_000) };
    const busy = await busyFor(page, window, ignore);
    return prisma.$transaction(async (tx) => {
        // Writing the page's row locks it until the transaction ends.
        const locked = await tx.calendarBookingPage.updateMany({ where: { id: page.id }, data: { updatedAt: new Date() } });
        if (locked.count === 0) return null;
        const slots = slotsAmong(page, window, now, busy, await holdsFor(tx, page, window, now, ignore));
        if (!slots.some((slot) => slot.start.getTime() === start.getTime())) return null;
        return write(tx);
    });
}

// ---------------------------------------------------------------- mail

function whenLine(start: Date, end: Date, zone: string, locale: string): string {
    const day = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: zone }).format(start);
    const time = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: zone });
    return `${day}, ${time.format(start)} - ${time.format(end)} (${zone})`;
}

async function mail(to: string, subject: string, lines: readonly string[]): Promise<boolean> {
    const result = await host.calendarHost.sendCalendarEmail({ to, subject, text: `${lines.join("\n")}\n` });
    if (result.error) console.error("polaris: a booking email was not sent:", result.error);
    return !result.error;
}

// ---------------------------------------------------------------- the visitor's side

/**
 * Hold a slot for a visitor and mail them the link that confirms it. Refused
 * when the slot is no longer offered, the answers do not fit the questions, or
 * this address or this visitor has asked too often.
 */
export async function requestBooking(input: BookingRequest, now = new Date()): Promise<{ email: string }> {
    const t = await calendarT();
    await throttle(`calendar.book:${await callerAddress()}`, 10, HOUR);
    await throttle(`calendar.book-email:${input.email}`, 5, HOUR);
    const page = await openPage(input.slug);
    if (!page) throw new CalendarRefusal(t("booking.pageGone"));
    const answers = answersSchemaFor(readQuestions(page.questions)).safeParse(input.answers);
    if (!answers.success) throw new CalendarRefusal(t("booking.validation.answerNeeded"));
    const start = new Date(input.start);
    const end = new Date(start.getTime() + page.durationMinutes * 60_000);

    // The same visitor asking for the same slot again: send the link again
    // rather than refusing them over their own hold.
    const own = await prisma.calendarBooking.findFirst({
        where: { pageId: page.id, email: input.email, start, status: "pending", createdAt: { gt: new Date(now.getTime() - HOLD_MS) } },
        select: { id: true, confirmToken: true }
    });

    const stored = { ...answers.data, ...(input.note ? { [NOTE_KEY]: input.note } : {}) };
    const booking =
        own ??
        (await claimSlot(page, start, now, {}, (client) =>
            client.calendarBooking.create({
                data: {
                    pageId: page.id,
                    name: input.name,
                    email: input.email,
                    answers: JSON.stringify(stored),
                    timezone: input.timezone,
                    start,
                    end,
                    confirmToken: newLinkToken(),
                    manageToken: newLinkToken()
                },
                select: { id: true, confirmToken: true }
            })
        ));
    if (!booking) throw new CalendarRefusal(t("booking.slotTaken"));

    const locale = await host.i18nRequest.getLocale();
    const base = await host.domainService.appBaseUrl();
    const sent = await mail(input.email, t("booking.mail.confirmSubject", { title: page.title }), [
        t("booking.mail.confirmIntro", { name: input.name }),
        "",
        page.title,
        whenLine(start, end, input.timezone, locale),
        ...(page.location ? [page.location] : []),
        "",
        t("booking.mail.confirmAction"),
        `${base}/cal/booking/${booking.confirmToken}`,
        "",
        t("booking.mail.confirmExpiry")
    ]);
    if (!sent) {
        if (!own) await prisma.calendarBooking.delete({ where: { id: booking.id } });
        throw new CalendarRefusal(t("booking.mailFailed"));
    }
    return { email: input.email };
}

async function bookingRowByToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const include = { page: true } as const;
    const byConfirm = await prisma.calendarBooking.findUnique({ where: { confirmToken: token }, include });
    if (byConfirm) return { row: byConfirm, via: "confirm" as const };
    const byManage = await prisma.calendarBooking.findUnique({ where: { manageToken: token }, include });
    return byManage ? { row: byManage, via: "manage" as const } : null;
}

type BookingRow = NonNullable<Awaited<ReturnType<typeof bookingRowByToken>>>["row"];

function stateOf(row: BookingRow, now: Date): ManagedBooking["state"] {
    if (row.status === "cancelled") return "cancelled";
    if (row.status === "pending") return row.createdAt.getTime() < now.getTime() - HOLD_MS ? "expired" : "pending";
    return row.end.getTime() < now.getTime() ? "past" : "confirmed";
}

/** A booking as its confirmation or manage link shows it. */
export async function bookingByToken(token: string, now = new Date()): Promise<ManagedBooking | null> {
    if (!(await bookingAllowed())) return null;
    const found = await bookingRowByToken(token);
    if (!found) return null;
    const { row, via } = found;
    return {
        state: stateOf(row, now),
        via,
        name: row.name,
        start: row.start.toISOString(),
        end: row.end.toISOString(),
        timezone: row.timezone || row.page.timezone,
        page: await publicView(row.page)
    };
}

/** The event a confirmed booking becomes. */
async function bookingEvent(page: PageRow, booking: BookingRow, conference: string): Promise<engine.CalendarItem> {
    const [owner] = await host.calendarHost.peopleByIds([page.ownerId]);
    const t = calendarTIn(await localeOf(page.ownerId));
    const answers = readAnswers(booking.answers);
    const lines = [
        ...(page.description ? [page.description, ""] : []),
        `${t("booking.bookedBy")}: ${booking.name} <${booking.email}>`,
        ...readQuestions(page.questions).flatMap((question) =>
            answers[question.id] ? [`${question.label}: ${answers[question.id]}`] : []
        ),
        ...(answers[NOTE_KEY] ? [`${t("booking.note")}: ${answers[NOTE_KEY]}`] : [])
    ];
    const at = (instant: Date) => ({
        dateTime: engine.formatWall(engine.instantToWall(instant, page.timezone)),
        tzid: page.timezone
    });
    return engine.eventItem(
        engine.newEvent({
            summary: t("booking.eventTitle", { title: page.title, name: booking.name }).slice(0, 500),
            description: lines.join("\n"),
            location: page.location,
            start: at(booking.start),
            end: at(booking.end),
            conference,
            organizer: owner ? { email: owner.email.toLowerCase(), name: owner.name } : null,
            attendees: [
                {
                    email: booking.email,
                    name: booking.name,
                    role: "REQ-PARTICIPANT",
                    partstat: "ACCEPTED",
                    rsvp: false,
                    type: "INDIVIDUAL"
                }
            ]
        })
    );
}

/** A Polaris meeting for the booking, when the page asks for one. A meeting that
 *  cannot be made leaves the booking without a link rather than failing it. */
async function meetingFor(page: PageRow, start: Date): Promise<string> {
    if (!page.meetingLink) return "";
    try {
        const scheduledAt = start.getTime() - Date.now() < 364 * DAY ? start : null;
        const created = await host.calendarHost.createMeetingLink(page.ownerId, { title: page.title, scheduledAt });
        return "link" in created ? created.link : "";
    } catch (caught) {
        console.error("polaris: a booking's meeting link was not made:", caught);
        return "";
    }
}

async function notifyOwner(page: PageRow, booking: BookingRow, key: "booking.notify.booked" | "booking.notify.cancelled" | "booking.notify.moved", href: string): Promise<void> {
    const t = await calendarTFor(page.ownerId);
    const locale = await localeOf(page.ownerId);
    await host.notificationsDispatch
        .notify({
            userId: page.ownerId,
            event: "calendar.booking",
            title: t(key, { name: booking.name, title: page.title }),
            body: whenLine(booking.start, booking.end, page.timezone, locale),
            href
        })
        .catch((caught: unknown) => console.error("polaris: a booking notice was not sent:", caught));
}

/**
 * Confirm a held slot from the link mailed to the visitor. The slot is checked
 * again first - between the hold and now the owner may have filled it, or
 * another visitor who asked earlier may have confirmed - and only one of two
 * simultaneous confirmations of one booking gets through.
 */
export async function confirmBooking(
    token: string,
    now = new Date()
): Promise<{ status: "confirmed" | "taken" | "expired" | "cancelled"; manageToken: string | null }> {
    const t = await calendarT();
    await throttle(`calendar.book-confirm:${await callerAddress()}`, 30, HOUR);
    const found = await bookingRowByToken(token);
    if (!found || found.via !== "confirm") throw new CalendarRefusal(t("booking.linkGone"));
    const booking = found.row;
    const page = booking.page;
    if (booking.status === "confirmed") return { status: "confirmed", manageToken: booking.manageToken };
    if (booking.status === "cancelled") return { status: "cancelled", manageToken: null };
    if (booking.createdAt.getTime() < now.getTime() - HOLD_MS) return { status: "expired", manageToken: null };
    if (!page.enabled || !(await bookingAllowed())) throw new CalendarRefusal(t("booking.pageGone"));

    const claimed = await claimSlot(page, booking.start, now, { bookingId: booking.id, holdsBefore: booking.createdAt }, (client) =>
        client.calendarBooking.updateMany({
            where: { id: booking.id, status: "pending" },
            data: { status: "confirmed" }
        })
    );
    if (!claimed) {
        await prisma.calendarBooking.updateMany({ where: { id: booking.id, status: "pending" }, data: { status: "cancelled" } });
        return { status: "taken", manageToken: null };
    }
    if (claimed.count === 0) {
        const again = await prisma.calendarBooking.findUnique({ where: { id: booking.id }, select: { status: true } });
        return again?.status === "confirmed"
            ? { status: "confirmed", manageToken: booking.manageToken }
            : { status: "cancelled", manageToken: null };
    }

    let objectId: string;
    try {
        const calendar = await requireWritableCalendar(page.ownerId, page.calendarId);
        const item = await bookingEvent(page, booking, await meetingFor(page, booking.start));
        objectId = await writeItem(calendar.id, null, item, { actor: null, floatingZone: page.timezone });
    } catch (caught) {
        // No event, no booking: give the slot back rather than confirm a time
        // nobody will find in their calendar.
        await prisma.calendarBooking.update({ where: { id: booking.id }, data: { status: "cancelled" } });
        if (caught instanceof CalendarRefusal) throw new CalendarRefusal(t("booking.pageGone"));
        throw caught;
    }
    await prisma.calendarBooking.update({ where: { id: booking.id }, data: { objectId } });
    await notifyOwner(page, booking, "booking.notify.booked", `/calendar/e/${objectId}`);

    const base = await host.domainService.appBaseUrl();
    const locale = await host.i18nRequest.getLocale();
    await mail(booking.email, t("booking.mail.confirmedSubject", { title: page.title }), [
        t("booking.mail.confirmedIntro", { name: booking.name }),
        "",
        page.title,
        whenLine(booking.start, booking.end, booking.timezone || page.timezone, locale),
        ...(page.location ? [page.location] : []),
        "",
        t("booking.mail.manageAction"),
        `${base}/cal/booking/${booking.manageToken}`
    ]);
    return { status: "confirmed", manageToken: booking.manageToken };
}

async function eventRow(objectId: string | null): Promise<StoredObject | null> {
    if (!objectId) return null;
    return prisma.calendarObject.findUnique({ where: { id: objectId }, select: OBJECT_COLUMNS });
}

/** Cancel a confirmed booking: its event goes to the trash, which mails the
 *  visitor the cancellation, and the owner is told. */
async function cancelConfirmed(booking: BookingRow, byOwner: boolean): Promise<void> {
    await prisma.calendarBooking.update({ where: { id: booking.id }, data: { status: "cancelled" } });
    const row = await eventRow(booking.objectId);
    if (row && !row.deletedAt) {
        const item = await itemOf(row).catch(() => null);
        if (item) await trashObject(row, item, { actor: null, floatingZone: booking.page.timezone });
    }
    if (!byOwner) await notifyOwner(booking.page, booking, "booking.notify.cancelled", "/calendar/booking");
}

async function managedRow(manageToken: string, now: Date): Promise<BookingRow> {
    const t = await calendarT();
    await throttle(`calendar.book-manage:${await callerAddress()}`, 30, HOUR);
    const found = await bookingRowByToken(manageToken);
    if (!found || found.via !== "manage") throw new CalendarRefusal(t("booking.linkGone"));
    const state = stateOf(found.row, now);
    if (state === "past") throw new CalendarRefusal(t("booking.alreadyPast"));
    if (state !== "confirmed") throw new CalendarRefusal(t("booking.notConfirmed"));
    return found.row;
}

/** The visitor cancels from their manage link. */
export async function cancelBooking(manageToken: string, now = new Date()): Promise<void> {
    await cancelConfirmed(await managedRow(manageToken, now), false);
}

/** The visitor moves their booking to another offered slot. */
export async function rescheduleBooking(manageToken: string, startIso: string, now = new Date()): Promise<{ start: string; end: string }> {
    const t = await calendarT();
    const booking = await managedRow(manageToken, now);
    const page = booking.page;
    if (!page.enabled || !(await bookingAllowed())) throw new CalendarRefusal(t("booking.pageGone"));
    const row = await eventRow(booking.objectId);
    const start = new Date(startIso);
    const end = new Date(start.getTime() + page.durationMinutes * 60_000);
    const moved = await claimSlot(page, start, now, { bookingId: booking.id, ...(row ? { uid: row.uid } : {}) }, (client) =>
        client.calendarBooking.updateMany({ where: { id: booking.id, status: "confirmed" }, data: { start, end } })
    );
    if (!moved) throw new CalendarRefusal(t("booking.slotTaken"));
    if (moved.count === 0) throw new CalendarRefusal(t("booking.notConfirmed"));
    if (row && !row.deletedAt) {
        const item = await itemOf(row);
        if (item.component === "VEVENT" && item.master) {
            const at = (instant: Date) => ({ dateTime: engine.formatWall(engine.instantToWall(instant, page.timezone)), tzid: page.timezone });
            const moved: engine.CalendarItem = {
                ...item,
                master: { ...item.master, start: at(start), end: at(end), sequence: item.master.sequence + 1 }
            };
            await writeItem(row.calendarId, row, moved, { actor: null, floatingZone: page.timezone });
        }
    }
    await notifyOwner(page, { ...booking, start, end }, "booking.notify.moved", row ? `/calendar/e/${row.id}` : "/calendar/booking");
    return { start: start.toISOString(), end: end.toISOString() };
}

/** The owner cancels a booking from their list. */
export async function cancelBookingAsOwner(user: SessionUser, bookingId: string): Promise<void> {
    const booking = await prisma.calendarBooking.findFirst({
        where: { id: bookingId, page: { ownerId: user.id } },
        include: { page: true }
    });
    const t = await calendarT();
    if (!booking) throw new CalendarRefusal(t("booking.notFound"));
    if (booking.status === "cancelled") return;
    if (booking.status === "pending") {
        await prisma.calendarBooking.update({ where: { id: booking.id }, data: { status: "cancelled" } });
        return;
    }
    await cancelConfirmed(booking, true);
}

/** Somebody's public booking pages, for their overview page. */
export async function publicPagesOf(userId: string): Promise<{ ownerName: string; pages: PublicBookingPage[] } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
    const [owner] = await host.calendarHost.peopleByIds([userId]);
    if (!owner) return null;
    if (!(await bookingAllowed())) return { ownerName: owner.name, pages: [] };
    const rows = await prisma.calendarBookingPage.findMany({
        where: { ownerId: owner.id, visibility: "public", enabled: true },
        orderBy: { title: "asc" },
        take: MAX_PAGES
    });
    return {
        ownerName: owner.name,
        pages: rows.map((row) => ({
            slug: row.slug,
            title: row.title,
            description: row.description,
            location: row.location,
            durationMinutes: row.durationMinutes,
            timezone: row.timezone,
            horizonDays: row.horizonDays,
            questions: [],
            ownerName: owner.name
        }))
    };
}

/** Drop holds nobody confirmed in time. Answers how many went. */
export async function sweepStaleBookings(now = new Date()): Promise<number> {
    const result = await prisma.calendarBooking.deleteMany({
        where: { status: "pending", createdAt: { lt: new Date(now.getTime() - HOLD_MS) } }
    });
    return result.count;
}
