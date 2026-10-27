/**
 * Announcements an administrator sends: storage, delivery and the clock.
 *
 * Delivery goes through the one notification pipeline (`notify`), so every
 * reader's rules, quiet hours and channels apply - except to a critical one,
 * which is a catalogue event marked critical and so always reaches the bell.
 * Each reader's notice is a condition keyed by the announcement, which is what
 * lets a later step (maintenance in progress, finished) or an edit rewrite the
 * same bell row instead of stacking three, and a retraction take it back.
 *
 * The banner is matched live against the audience and the clock, so an edit or
 * a reschedule is right on the next read with nothing to invalidate. Every
 * write that changes what a banner shows says so on the shell's live channel
 * (`shell-notices-live`), so the tabs it concerns read it again at once.
 */

import { prisma } from "@polaris/db";
import { plainText } from "./markdown";
import type { Locale } from "@polaris/core";
import { notify } from "@/lib/notifications/dispatch";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { renderFor, type Reader, type RenderInput } from "./templates";
import { publishNoticeChange } from "@/lib/shell-notices-live";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";
import { audiencePages, countAudience, matchesAudience, membershipOf } from "./audience";
import {
    bannerDismissible,
    bannerHidden,
    bannerShowing,
    FINISHED_SHOWN_MS,
    levelFor,
    nextChangeIn,
    noticeDue,
    phaseAt,
    type Phase
} from "./phase";
import {
    audienceSchema,
    DEFAULT_LEAD_MINUTES,
    HISTORY_PAGE,
    NOBODY,
    type AudienceSpec,
    type ComposeInput
} from "./schema";

export const NOTICE_EVENT = "instance.announcement";
export const CRITICAL_EVENT = "instance.announcement.critical";
const BANNER_LIMIT = 5;
const BANNER_SCAN = 200;
/** Updates a details page lists; past this an announcement wants a new one. */
const UPDATES_SHOWN = 100;
const HISTORY_MAX = 1000;
const CLOCK_BATCH = 50;
const SEND_CONCURRENCY = 20;
/** A send that has not finished a page in this long has died, and the clock resumes it. */
const SEND_STALE_MS = 5 * 60_000;

export function conditionKeyFor(id: string): string {
    return `announcement:${id}`;
}

export type AnnouncementRow = NonNullable<
    Awaited<ReturnType<typeof prisma.announcement.findUnique>>
>;

/** Tell the open tabs of these audiences that their banners changed. */
export function announceBannerChange(...audiences: AudienceSpec[]): void {
    publishNoticeChange({ topic: "announcements", reach: { audiences } });
}

export function readAudience(raw: string): AudienceSpec {
    try {
        const parsed = audienceSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : NOBODY;
    } catch {
        return NOBODY;
    }
}

export function readAffected(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        const affected = (parsed as { affected?: unknown } | null)?.affected;
        return Array.isArray(affected)
            ? affected.filter((one): one is string => typeof one === "string")
            : [];
    } catch {
        return [];
    }
}

function renderInput(row: AnnouncementRow): RenderInput {
    return {
        kind: row.kind,
        template: row.template,
        localized: row.localized,
        title: row.title,
        body: row.body,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        affected: readAffected(row.vars)
    };
}

/**
 * The columns a compose form becomes. Maintenance starts showing its lead ahead
 * of the window and stops two hours after it, so "what is showing now" is one
 * indexed range for both kinds.
 */
export function columnsFor(input: ComposeInput, now: Date) {
    const maintenance = input.kind === "maintenance";
    const windowStart = maintenance && input.windowStart ? new Date(input.windowStart) : null;
    const windowEnd = maintenance && input.windowEnd ? new Date(input.windowEnd) : null;
    const lead = input.leadMinutes ?? DEFAULT_LEAD_MINUTES;
    const startsAt = windowStart
        ? new Date(
              Math.min(
                  windowStart.getTime(),
                  Math.max(now.getTime(), windowStart.getTime() - lead * 60_000)
              )
          )
        : input.startsAt
          ? new Date(input.startsAt)
          : now;
    const endsAt = windowEnd
        ? new Date(windowEnd.getTime() + FINISHED_SHOWN_MS)
        : input.endsAt
          ? new Date(input.endsAt)
          : null;
    return {
        kind: input.kind,
        template: input.template,
        localized: input.localized,
        severity: input.severity,
        title: input.title,
        body: input.body,
        details: input.details,
        linkUrl: input.linkUrl,
        linkLabel: input.linkUrl ? input.linkLabel : null,
        vars: JSON.stringify({ affected: input.affected }),
        audience: JSON.stringify(input.audience),
        sendNotice: input.sendNotice,
        showBanner: input.showBanner,
        startsAt,
        endsAt,
        windowStart,
        windowEnd,
        leadMinutes: maintenance ? lead : null,
        notifySteps: maintenance && input.notifySteps
    };
}

/** A row back as the compose form it came from, for edit and duplicate. */
export function composeFrom(row: AnnouncementRow): ComposeInput {
    const maintenance = row.kind === "maintenance";
    return {
        kind: maintenance ? "maintenance" : "announcement",
        template: row.template as ComposeInput["template"],
        localized: row.localized,
        severity: row.severity as ComposeInput["severity"],
        title: row.title,
        body: row.body,
        details: row.details,
        linkUrl: row.linkUrl,
        linkLabel: row.linkLabel,
        audience: readAudience(row.audience),
        sendNotice: row.sendNotice,
        showBanner: row.showBanner,
        startsAt: maintenance ? null : row.startsAt.toISOString(),
        endsAt: maintenance || !row.endsAt ? null : row.endsAt.toISOString(),
        windowStart: row.windowStart?.toISOString() ?? null,
        windowEnd: row.windowEnd?.toISOString() ?? null,
        leadMinutes: row.leadMinutes,
        affected: readAffected(row.vars),
        notifySteps: row.notifySteps
    };
}

async function readerFor(userId: string): Promise<Reader> {
    const locale: Locale = await getUserLocale(userId);
    const prefs = await resolveDisplayPreferencesFor(userId, locale).catch(() => null);
    return { locale, timeZone: prefs?.timeZone ?? "UTC" };
}

async function deliverTo(row: AnnouncementRow, phase: Phase, userId: string): Promise<void> {
    const text = renderFor(renderInput(row), phase, await readerFor(userId));
    const audience = readAudience(row.audience);
    await notify({
        userId,
        event: row.severity === "critical" ? CRITICAL_EVENT : NOTICE_EVENT,
        title: text.title,
        body: plainText(text.body) || null,
        href: row.linkUrl?.startsWith("/") ? row.linkUrl : null,
        level: levelFor(row.severity),
        audience: audience.everyone ? "everyone" : "you",
        metadata: { announcementId: row.id, link: row.linkUrl },
        condition: conditionKeyFor(row.id),
        resurface: true
    });
}

/** A notice that went out after its announcement was retracted comes back off the bells. */
async function takeBackIfRetracted(id: string): Promise<void> {
    const row = await prisma.announcement.findUnique({
        where: { id },
        select: { retractedAt: true }
    });
    if (row?.retractedAt)
        await prisma.notification.deleteMany({ where: { conditionKey: conditionKeyFor(id) } });
}

/**
 * Tell every reader in the audience about this phase, after `from` when it
 * resumes. Returns how many it reached.
 *
 * The send holds a lease on the row and moves a cursor with it after each page,
 * so one that dies partway is picked up by the clock where it stopped. It stops
 * as soon as it loses the lease - retracted, edited, or taken over by a resume.
 */
export async function deliver(
    row: AnnouncementRow,
    phase: Phase,
    lease: Date,
    from: string | null = null
): Promise<number> {
    let reached = 0;
    let held = lease;
    for await (const page of audiencePages(readAudience(row.audience), from)) {
        for (let at = 0; at < page.length; at += SEND_CONCURRENCY) {
            const slice = page.slice(at, at + SEND_CONCURRENCY);
            await Promise.all(
                slice.map((userId) =>
                    deliverTo(row, phase, userId).catch((error) => {
                        console.error("polaris: an announcement notice failed:", error);
                    })
                )
            );
            reached += slice.length;
        }
        const next = new Date();
        const kept = await prisma.announcement.updateMany({
            where: { id: row.id, noticedPhase: phase, sendLease: held, retractedAt: null },
            data: { sendCursor: page[page.length - 1], sendLease: next }
        });
        if (kept.count !== 1) {
            await takeBackIfRetracted(row.id);
            return reached;
        }
        held = next;
    }
    const done = await prisma.announcement.updateMany({
        where: { id: row.id, noticedPhase: phase, sendLease: held, retractedAt: null },
        data: { sendCursor: null, sendLease: null }
    });
    if (done.count !== 1) await takeBackIfRetracted(row.id);
    return reached;
}

/**
 * Send whatever notice is due for one row, once.
 *
 * The claim is a conditional update on the phase last announced, so two
 * runners - the clock and the action that has just saved it - never both send.
 */
export async function advance(row: AnnouncementRow, now: Date): Promise<Phase | null> {
    const phase = phaseAt(row, now);
    const due = noticeDue({
        phase,
        noticedPhase: row.noticedPhase,
        sendNotice: row.sendNotice,
        notifySteps: row.notifySteps
    });
    if (!due) return null;
    const lease = new Date();
    const claimed = await prisma.announcement.updateMany({
        where: { id: row.id, noticedPhase: row.noticedPhase, retractedAt: null },
        data: { noticedPhase: due, sendCursor: null, sendLease: lease }
    });
    if (claimed.count !== 1) return null;
    if (row.showBanner) announceBannerChange(readAudience(row.audience));
    await deliver(row, due, lease);
    return due;
}

/** Pick up a send that died partway, after the last reader it reached. */
export async function resume(row: AnnouncementRow, now: Date): Promise<boolean> {
    if (!row.sendLease || !row.noticedPhase) return false;
    if (now.getTime() - row.sendLease.getTime() < SEND_STALE_MS) return false;
    const lease = new Date();
    const claimed = await prisma.announcement.updateMany({
        where: {
            id: row.id,
            noticedPhase: row.noticedPhase,
            sendLease: row.sendLease,
            retractedAt: null
        },
        data: { sendLease: lease }
    });
    if (claimed.count !== 1) return false;
    await deliver(row, row.noticedPhase as Phase, lease, row.sendCursor);
    return true;
}

/**
 * The scheduled job: every row that may still owe a notice - never announced,
 * maintenance with steps still to tell, or a send that stopped partway. One
 * already told is left out, so open-ended ones never crowd out the rest.
 */
export async function runAnnouncementClock(now: Date = new Date()): Promise<{ sent: number }> {
    const stale = new Date(now.getTime() - SEND_STALE_MS);
    let sent = 0;
    let after: string | null = null;
    for (;;) {
        const rows: AnnouncementRow[] = await prisma.announcement.findMany({
            where: {
                retractedAt: null,
                sendNotice: true,
                startsAt: { lte: now },
                AND: [
                    { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
                    {
                        OR: [
                            { noticedPhase: null },
                            { notifySteps: true },
                            { sendLease: { lte: stale } }
                        ]
                    }
                ]
            },
            orderBy: [{ startsAt: "asc" }, { id: "asc" }],
            ...(after ? { cursor: { id: after }, skip: 1 } : {}),
            take: CLOCK_BATCH
        });
        for (const row of rows) {
            if (await advance(row, now).catch(() => null)) sent += 1;
            else await resume(row, now).catch(() => false);
        }
        if (rows.length < CLOCK_BATCH) return { sent };
        after = rows[rows.length - 1]!.id;
    }
}

export async function createAnnouncement(actorId: string, input: ComposeInput, now = new Date()) {
    const columns = columnsFor(input, now);
    const reach = await countAudience(input.audience);
    const row = await prisma.announcement.create({
        data: { ...columns, reach, createdById: actorId }
    });
    announceBannerChange(input.audience);
    // Due now: sent here rather than a minute from now by the clock.
    void advance(row, now).catch((error) =>
        console.error("polaris: sending an announcement failed:", error)
    );
    return row;
}

/** Whether a row can still be edited: it has not started, or it is maintenance still ahead. */
export function editable(row: AnnouncementRow, now: Date): boolean {
    const phase = phaseAt(row, now);
    return phase === "scheduled" || phase === "upcoming";
}

/**
 * Change one that has not happened yet. A maintenance notice already out is
 * rewritten in place on the readers' bells by the next tick, which is the
 * "rescheduled" readers need to see.
 */
export async function updateAnnouncement(id: string, input: ComposeInput, now = new Date()) {
    const row = await prisma.announcement.findUnique({ where: { id } });
    if (!row || !editable(row, now)) return null;
    const columns = columnsFor(input, now);
    const reach = await countAudience(input.audience);
    const updated = await prisma.announcement.update({
        where: { id },
        data: { ...columns, reach, noticedPhase: null, sendCursor: null, sendLease: null }
    });
    // The audience it had and the one it has: somebody taken out of it loses the banner.
    announceBannerChange(readAudience(row.audience), input.audience);
    void advance(updated, now).catch(() => null);
    return updated;
}

/** Take it back: off every banner, and its notices off every bell. */
export async function retractAnnouncement(id: string, now = new Date()): Promise<boolean> {
    const done = await prisma.announcement.updateMany({
        where: { id, retractedAt: null },
        data: { retractedAt: now }
    });
    if (done.count === 0) return false;
    const row = await prisma.announcement.findUnique({ where: { id }, select: { audience: true } });
    announceBannerChange(row ? readAudience(row.audience) : { ...NOBODY, everyone: true });
    await prisma.notification.deleteMany({ where: { conditionKey: conditionKeyFor(id) } });
    return true;
}

/**
 * End it now. An announcement stops showing; maintenance under way is finished
 * now (and says so); maintenance that has not started is cancelled, which is a
 * retraction.
 */
export async function endAnnouncement(
    id: string,
    now = new Date()
): Promise<"ended" | "cancelled" | null> {
    const row = await prisma.announcement.findUnique({ where: { id } });
    if (!row || row.retractedAt) return null;
    const phase = phaseAt(row, now);
    if (row.kind === "maintenance" && (phase === "scheduled" || phase === "upcoming")) {
        return (await retractAnnouncement(id, now)) ? "cancelled" : null;
    }
    if (row.kind === "maintenance" && phase === "inProgress") {
        const updated = await prisma.announcement.update({
            where: { id },
            data: { windowEnd: now, endsAt: new Date(now.getTime() + FINISHED_SHOWN_MS) }
        });
        announceBannerChange(readAudience(row.audience));
        void advance(updated, now).catch(() => null);
        return "ended";
    }
    await prisma.announcement.update({ where: { id }, data: { endsAt: now } });
    announceBannerChange(readAudience(row.audience));
    return "ended";
}

export interface BannerView {
    id: string;
    severity: string;
    phase: Phase;
    title: string;
    body: string;
    linkUrl: string | null;
    linkLabel: string | null;
    /** Where "See details" goes, when there is more to read than the banner says. */
    detailsUrl: string | null;
    dismissible: boolean;
    /** The moment a countdown counts to: the window's start while it is upcoming. */
    countdownTo: string | null;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2, success: 3 };

/** Order a stack: critical first, maintenance under way next, then newest. */
export function sortBanners<T extends { severity: string; phase: Phase; startsAt: Date }>(
    rows: T[]
): T[] {
    return [...rows].sort(
        (a, b) =>
            (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
            Number(b.phase === "inProgress") - Number(a.phase === "inProgress") ||
            b.startsAt.getTime() - a.startsAt.getTime()
    );
}

/** What the shell draws for one reader right now. One indexed read when nothing is up. */
export async function bannersFor(
    userId: string,
    reader: Reader,
    now = new Date()
): Promise<BannerView[]> {
    return (await readBanners(userId, reader, now)).banners;
}

/** The banners, and how long until one of them - or one not up yet - changes phase. */
export interface BannerState {
    banners: BannerView[];
    /** Milliseconds from the server's now, so a tab's own clock being off does not matter. */
    nextChangeInMs: number | null;
}

/** What a tab draws now and when it should read again by itself. */
export async function bannerStateFor(
    userId: string,
    reader: Reader,
    now = new Date()
): Promise<BannerState> {
    const [read, ahead] = await Promise.all([
        readBanners(userId, reader, now),
        prisma.announcement.findFirst({
            where: { showBanner: true, retractedAt: null, startsAt: { gt: now } },
            orderBy: { startsAt: "asc" },
            select: { startsAt: true }
        })
    ]);
    const edges = [read.nextChangeInMs, ahead ? ahead.startsAt.getTime() - now.getTime() : null];
    const due = edges.filter((edge): edge is number => edge !== null);
    return { banners: read.banners, nextChangeInMs: due.length > 0 ? Math.min(...due) : null };
}

async function readBanners(
    userId: string,
    reader: Reader,
    now: Date
): Promise<{ banners: BannerView[]; nextChangeInMs: number | null }> {
    const rows = await prisma.announcement.findMany({
        where: {
            showBanner: true,
            retractedAt: null,
            startsAt: { lte: now },
            OR: [{ endsAt: null }, { endsAt: { gt: now } }]
        },
        orderBy: { startsAt: "desc" },
        take: BANNER_SCAN,
        include: { _count: { select: { updates: true } } }
    });
    if (rows.length === 0) return { banners: [], nextChangeInMs: null };
    let member: Awaited<ReturnType<typeof membershipOf>> | undefined;
    const dismissals = await prisma.announcementDismissal.findMany({
        where: { userId, announcementId: { in: rows.map((row) => row.id) } },
        select: { announcementId: true, phase: true }
    });
    const closed = new Map(dismissals.map((one) => [one.announcementId, one.phase]));
    const showing = [];
    for (const row of rows) {
        const phase = phaseAt(row, now);
        if (!bannerShowing(phase) || bannerHidden(phase, closed.get(row.id), row.severity))
            continue;
        const audience = readAudience(row.audience);
        if (!audience.everyone) {
            member ??= await membershipOf(userId);
            if (!matchesAudience(member, audience)) continue;
        }
        showing.push({ row, phase, severity: row.severity, startsAt: row.startsAt });
    }
    const edges = rows
        .map((row) => nextChangeIn(row, now))
        .filter((edge): edge is number => edge !== null);
    const banners = sortBanners(showing)
        .slice(0, BANNER_LIMIT)
        .map(({ row, phase }) => {
            const text = renderFor(renderInput(row), phase, reader);
            return {
                id: row.id,
                severity: row.severity,
                phase,
                title: text.title,
                body: text.body,
                linkUrl: row.linkUrl,
                linkLabel: row.linkLabel,
                detailsUrl: hasDetails(row, row._count?.updates ?? 0) ? detailsPath(row.id) : null,
                dismissible: bannerDismissible(row.severity, phase),
                countdownTo:
                    phase === "upcoming" && row.windowStart ? row.windowStart.toISOString() : null
            };
        });
    return { banners, nextChangeInMs: edges.length > 0 ? Math.min(...edges) : null };
}

/** The page an announcement's details are read on. */
export function detailsPath(id: string): string {
    return `/announcements/${id}`;
}

/**
 * Whether there is more to read than the banner says: written details, an
 * update added since, or a maintenance window, whose page lists the window and
 * what it touches.
 */
export function hasDetails(
    row: Pick<AnnouncementRow, "kind" | "details">,
    updates: number
): boolean {
    return row.kind === "maintenance" || (row.details ?? "").trim().length > 0 || updates > 0;
}

export interface AnnouncementDetails {
    id: string;
    kind: string;
    severity: string;
    phase: Phase;
    title: string;
    body: string;
    details: string;
    linkUrl: string | null;
    linkLabel: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    affected: string[];
    startsAt: string;
    updates: { id: string; body: string; createdAt: string }[];
}

/**
 * One announcement as its details page shows it, or null when this reader may
 * not read it: not in its audience, taken back, or not started yet. An
 * administrator reads any of them, so the history can link to the page.
 */
export async function detailsFor(
    userId: string,
    isAdmin: boolean,
    id: string,
    reader: Reader,
    now = new Date()
): Promise<AnnouncementDetails | null> {
    const row = await prisma.announcement.findUnique({
        where: { id },
        include: {
            updates: {
                orderBy: { createdAt: "asc" },
                take: UPDATES_SHOWN,
                select: { id: true, body: true, createdAt: true }
            }
        }
    });
    if (!row) return null;
    if (!isAdmin) {
        if (row.retractedAt || row.startsAt > now) return null;
        const audience = readAudience(row.audience);
        if (!audience.everyone && !matchesAudience(await membershipOf(userId), audience))
            return null;
    }
    const phase = phaseAt(row, now);
    const text = renderFor(renderInput(row), phase, reader);
    return {
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        phase,
        title: text.title,
        body: text.body,
        details: row.details,
        linkUrl: row.linkUrl,
        linkLabel: row.linkLabel,
        windowStart: row.windowStart?.toISOString() ?? null,
        windowEnd: row.windowEnd?.toISOString() ?? null,
        affected: readAffected(row.vars),
        startsAt: row.startsAt.toISOString(),
        updates: (row.updates ?? []).map((one) => ({
            id: one.id,
            body: one.body,
            createdAt: one.createdAt.toISOString()
        }))
    };
}

/** Add an update to an announcement still standing, and tell its audience's tabs. */
export async function addAnnouncementUpdate(
    actorId: string,
    id: string,
    body: string,
    now = new Date()
): Promise<boolean> {
    const row = await prisma.announcement.findUnique({
        where: { id },
        select: { audience: true, retractedAt: true }
    });
    if (!row || row.retractedAt) return false;
    await prisma.announcementUpdate.create({
        data: { announcementId: id, body, createdById: actorId, createdAt: now }
    });
    // The first update is what gives a banner its "See details".
    announceBannerChange(readAudience(row.audience));
    return true;
}
/** Close a banner for one reader, for the phase it is in. Refused when it may not be closed. */
export async function dismissBanner(
    userId: string,
    id: string,
    now = new Date()
): Promise<boolean> {
    const row = await prisma.announcement.findUnique({ where: { id } });
    if (!row || !row.showBanner) return false;
    const phase = phaseAt(row, now);
    if (!bannerShowing(phase) || !bannerDismissible(row.severity, phase)) return false;
    const audience = readAudience(row.audience);
    if (!audience.everyone && !matchesAudience(await membershipOf(userId), audience)) return false;
    await prisma.announcementDismissal.upsert({
        where: { announcementId_userId: { announcementId: id, userId } },
        create: { announcementId: id, userId, phase },
        update: { phase, dismissedAt: now }
    });
    // The reader's other tabs close it too.
    announceBannerChange({ ...NOBODY, userIds: [userId] });
    return true;
}

export interface HistoryRow {
    id: string;
    kind: string;
    severity: string;
    title: string;
    phase: Phase;
    audience: AudienceSpec;
    reach: number;
    read: number;
    dismissed: number;
    sendNotice: boolean;
    showBanner: boolean;
    startsAt: string;
    endsAt: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    createdAt: string;
    editable: boolean;
}

/**
 * Announcements newest first with their reach and how many readers opened
 * them, `take` at a time after the row `after`. Three reads.
 */
export async function listHistory(
    { after = null, take = HISTORY_PAGE }: { after?: string | null; take?: number } = {},
    now = new Date()
): Promise<HistoryRow[]> {
    const rows = await prisma.announcement.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        take: Math.min(Math.max(1, take), HISTORY_MAX)
    });
    if (rows.length === 0) return [];
    const [reads, dismissed] = await Promise.all([
        prisma.notification.groupBy({
            by: ["conditionKey"],
            where: {
                conditionKey: { in: rows.map((row) => conditionKeyFor(row.id)) },
                readAt: { not: null }
            },
            _count: { _all: true }
        }),
        prisma.announcementDismissal.groupBy({
            by: ["announcementId"],
            where: { announcementId: { in: rows.map((row) => row.id) } },
            _count: { _all: true }
        })
    ]);
    const readBy = new Map(reads.map((one) => [one.conditionKey, one._count._all]));
    const closedBy = new Map(dismissed.map((one) => [one.announcementId, one._count._all]));
    return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        phase: phaseAt(row, now),
        audience: readAudience(row.audience),
        reach: row.reach,
        read: readBy.get(conditionKeyFor(row.id)) ?? 0,
        dismissed: closedBy.get(row.id) ?? 0,
        sendNotice: row.sendNotice,
        showBanner: row.showBanner,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt?.toISOString() ?? null,
        windowStart: row.windowStart?.toISOString() ?? null,
        windowEnd: row.windowEnd?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        editable: editable(row, now)
    }));
}

export async function findAnnouncement(id: string) {
    return prisma.announcement.findUnique({ where: { id } });
}

export { countAudience };
