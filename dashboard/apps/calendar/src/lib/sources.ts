/**
 * The outside calendars somebody links: a Google or Microsoft account they
 * already linked to Polaris, a CalDAV server (iCloud, Fastmail, Nextcloud,
 * Yahoo, any other) with an app password, or one ICS address (Proton, a
 * holiday calendar, anything that publishes a feed).
 *
 * Adding one checks it answers before anything is stored - discovery for
 * CalDAV, one fetch for a feed - so a wrong password is said on the form rather
 * than found later as a calendar that never fills. The first pull then runs in
 * the background; the screen shows the calendars as they arrive.
 *
 * Server-only.
 */

import * as sync from "./sync";
import { calendarT } from "./i18n";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { SourceView } from "./wire";
import { CalendarRefusal } from "./errors";
import type { SessionUser } from "./access";
import {
    feedAddressOf,
    fetcherFor,
    ownerMayReachLan,
    sealFeedAddress,
    syncSource
} from "./sync-engine";

/** Sources one person may link. More than anybody reads; a bound all the same. */
const MAX_SOURCES = 50;

const VIEW = {
    id: true,
    kind: true,
    label: true,
    url: true,
    username: true,
    status: true,
    lastError: true,
    lastSyncAt: true,
    refreshMinutes: true,
    connectionId: true,
    _count: { select: { calendars: true } }
} as const;

function view(row: {
    id: string;
    kind: string;
    label: string;
    url: string;
    username: string;
    status: string;
    lastError: string | null;
    lastSyncAt: Date | null;
    refreshMinutes: number;
    connectionId: string | null;
    _count: { calendars: number };
}): SourceView {
    return {
        id: row.id,
        kind: row.kind as SourceView["kind"],
        label: row.label,
        url: row.url,
        username: row.username,
        status:
            (["ok", "auth", "unreachable", "error"] as const).find(
                (status) => status === row.status
            ) ?? "error",
        lastError: row.lastError,
        lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
        refreshMinutes: row.refreshMinutes,
        calendarCount: row._count.calendars,
        connectionId: row.connectionId
    };
}

const FEED_SECRET = {
    id: true,
    url: true,
    encryptedSecret: true,
    secretNonce: true,
    secretKeyId: true
} as const;

/** The addresses of this person's feeds, opened. A feed subscribed before
 *  addresses were sealed is sealed on the way. */
async function feedAddresses(user: SessionUser): Promise<string[]> {
    const feeds = await prisma.calendarSource.findMany({
        where: { userId: user.id, kind: "ics" },
        select: FEED_SECRET
    });
    const addresses: string[] = [];
    for (const feed of feeds) {
        const address = await feedAddressOf(feed);
        if (address) addresses.push(address);
    }
    return addresses;
}

/** Which of these public addresses - the holiday list, the operator's
 *  suggestions - this person already subscribes to. */
export async function subscribedAmong(
    user: SessionUser,
    catalog: readonly string[]
): Promise<string[]> {
    const held = new Set(await feedAddresses(user));
    return catalog.filter((address) => held.has(sync.feedUrl(address)));
}

export async function listSources(user: SessionUser): Promise<SourceView[]> {
    await feedAddresses(user);
    const rows = await prisma.calendarSource.findMany({
        where: { userId: user.id },
        select: VIEW,
        orderBy: { createdAt: "asc" }
    });
    return rows.map(view);
}

async function roomForAnother(user: SessionUser): Promise<void> {
    const held = await prisma.calendarSource.count({ where: { userId: user.id } });
    if (held >= MAX_SOURCES) throw new CalendarRefusal((await calendarT())("sources.tooMany"));
}

/** Pull a new source's calendars without holding the screen. */
function firstPull(sourceId: string): void {
    void syncSource(sourceId).catch((caught: unknown) =>
        console.error("polaris: a new calendar source did not sync:", caught)
    );
}

/**
 * The fetch one check goes through, remembering whether it refused an address
 * on a private network: the protocol clients report every failed fetch as the
 * server being unreachable, and that one deserves its own sentence.
 */
async function checkingFetcher(
    user: SessionUser
): Promise<{ fetcher: sync.Fetcher; refusedAddress: () => boolean }> {
    const guarded = fetcherFor(await ownerMayReachLan(user.id));
    let refused = false;
    const fetcher: sync.Fetcher = async (url, init) => {
        try {
            return await guarded(url, init);
        } catch (caught) {
            if (caught instanceof Error && caught.name === "RefusedAddressError") refused = true;
            throw caught;
        }
    };
    return { fetcher, refusedAddress: () => refused };
}

/** A sentence for why an address or a server could not be used. */
async function refusalFor(caught: unknown, refusedAddress = false): Promise<CalendarRefusal> {
    const t = await calendarT();
    if (refusedAddress) return new CalendarRefusal(t("sources.privateAddress"));
    if (caught instanceof CalendarRefusal) return caught;
    if (caught instanceof sync.SyncAuthError)
        return new CalendarRefusal(t("sources.refusedCredentials"));
    if (caught instanceof sync.SyncUnreachableError)
        return new CalendarRefusal(t("sources.unreachable"));
    if (caught instanceof Error && caught.name === "RefusedAddressError")
        return new CalendarRefusal(t("sources.privateAddress"));
    if (caught instanceof sync.SyncNotFoundError) return new CalendarRefusal(t("sources.notFound"));
    if (caught instanceof sync.SyncError) return new CalendarRefusal(t("sources.notACalendar"));
    console.error("polaris: a calendar source could not be checked:", caught);
    return new CalendarRefusal(t("sources.unreachable"));
}

/** One fetch of a feed's address, refused in a sentence when it is not a calendar
 *  or the operator turned subscriptions off. */
async function checkFeed(user: SessionUser, url: string): Promise<void> {
    const { readInstanceSettings } = await import("./instance-settings");
    if (!(await readInstanceSettings()).allowSubscriptions) {
        throw new CalendarRefusal((await calendarT())("instance.subscriptionsOff"));
    }
    const check = await checkingFetcher(user);
    try {
        const first = await sync.fetchIcsFeed({
            url,
            etag: null,
            lastModified: null,
            fetcher: check.fetcher
        });
        if (first.notModified) throw new sync.SyncRefusedError("empty", null);
    } catch (caught) {
        throw await refusalFor(caught, check.refusedAddress());
    }
}

/** Subscribe to one ICS address. Read-only; the feed decides what is in it. */
export async function addFeed(
    user: SessionUser,
    input: { url: string; name: string; color: string; refreshMinutes: number }
): Promise<string> {
    await roomForAnother(user);
    await checkFeed(user, input.url);
    const sealed = await host.calendarHost.sealCalendarSecret(sync.feedUrl(input.url));
    const source = await prisma.calendarSource.create({
        data: {
            userId: user.id,
            kind: "ics",
            label: input.name,
            url: sync.maskFeedAddress(input.url),
            ...sealed,
            refreshMinutes: input.refreshMinutes
        },
        select: { id: true }
    });
    await prisma.calendar.create({
        data: {
            ownerId: user.id,
            sourceId: source.id,
            kind: "remote",
            remoteId: sync.FEED_REMOTE_ID,
            name: input.name,
            color: input.color,
            readOnly: true
        }
    });
    firstPull(source.id);
    return source.id;
}

/** Link a CalDAV server: discovery first, and nothing stored if it refuses. */
export async function addCalDav(
    user: SessionUser,
    input: { url: string; username: string; password: string }
): Promise<string> {
    await roomForAnother(user);
    const check = await checkingFetcher(user);
    let found: Awaited<ReturnType<typeof sync.discoverCalDav>>;
    try {
        found = await sync.discoverCalDav({
            url: input.url,
            username: input.username,
            password: input.password,
            fetcher: check.fetcher
        });
    } catch (caught) {
        throw await refusalFor(caught, check.refusedAddress());
    }
    const sealed = await host.calendarHost.sealCalendarSecret(input.password);
    const host_ = new URL(found.serverUrl).hostname;
    const source = await prisma.calendarSource.create({
        data: {
            userId: user.id,
            kind: "caldav",
            label: `${input.username} (${host_})`.slice(0, 200),
            url: found.serverUrl,
            username: input.username,
            encryptedSecret: sealed.encryptedSecret,
            secretNonce: sealed.secretNonce,
            secretKeyId: sealed.secretKeyId
        },
        select: { id: true }
    });
    firstPull(source.id);
    return source.id;
}

/**
 * Read calendars through a Google or Microsoft account this person linked. The
 * link has to carry calendar access - one made for a backup or for mail does
 * not, and the screen sends them to authorize it for calendars instead.
 */
export async function addLinkedAccount(user: SessionUser, connectionId: string): Promise<string> {
    const links = await host.calendarHost.listCalendarLinks(user.id);
    const link = links.find((candidate) => candidate.id === connectionId);
    const t = await calendarT();
    if (!link) throw new CalendarRefusal(t("sources.linkNotFound"));
    if (!link.grantsCalendar) throw new CalendarRefusal(t("sources.linkNeedsCalendar"));
    const existing = await prisma.calendarSource.findFirst({
        where: { userId: user.id, connectionId },
        select: { id: true }
    });
    if (existing) {
        firstPull(existing.id);
        return existing.id;
    }
    await roomForAnother(user);
    const source = await prisma.calendarSource.create({
        data: { userId: user.id, kind: link.provider, label: link.label, connectionId },
        select: { id: true }
    });
    firstPull(source.id);
    return source.id;
}

async function ownSource(user: SessionUser, id: string) {
    const row = await prisma.calendarSource.findFirst({
        where: { id, userId: user.id },
        select: { id: true, kind: true }
    });
    if (!row) throw new CalendarRefusal((await calendarT())("sources.notFound"));
    return row;
}

/** Pull a source now, answering when the pass is done. */
export async function refreshSource(user: SessionUser, id: string): Promise<SourceView> {
    const source = await ownSource(user, id);
    await syncSource(source.id);
    const row = await prisma.calendarSource.findUniqueOrThrow({
        where: { id: source.id },
        select: VIEW
    });
    return view(row);
}

/** Change how often a source is pulled, give a CalDAV server a new password, or
 *  a feed a new address (each checked before it is stored). */
export async function updateSource(
    user: SessionUser,
    id: string,
    patch: { refreshMinutes?: number; password?: string; url?: string }
): Promise<SourceView> {
    const source = await ownSource(user, id);
    const data: Record<string, unknown> = {};
    if (patch.refreshMinutes !== undefined) data.refreshMinutes = patch.refreshMinutes;
    if (patch.url !== undefined && source.kind === "ics") {
        await checkFeed(user, patch.url);
        await sealFeedAddress(id, patch.url);
        // The validators belong to the old address.
        await prisma.calendar.updateMany({
            where: { sourceId: id },
            data: { syncToken: "", ctag: "" }
        });
        Object.assign(data, { status: "ok", lastError: null, nextSyncAt: new Date() });
    }
    if (patch.password !== undefined && source.kind === "caldav") {
        const row = await prisma.calendarSource.findUniqueOrThrow({
            where: { id },
            select: { url: true, username: true }
        });
        const check = await checkingFetcher(user);
        try {
            await sync.discoverCalDav({
                url: row.url,
                username: row.username,
                password: patch.password,
                fetcher: check.fetcher
            });
        } catch (caught) {
            throw await refusalFor(caught, check.refusedAddress());
        }
        const sealed = await host.calendarHost.sealCalendarSecret(patch.password);
        Object.assign(data, sealed, { status: "ok", lastError: null, nextSyncAt: new Date() });
    }
    if (Object.keys(data).length > 0) await prisma.calendarSource.update({ where: { id }, data });
    if (patch.url !== undefined && source.kind === "ics") firstPull(id);
    return view(await prisma.calendarSource.findUniqueOrThrow({ where: { id }, select: VIEW }));
}

/** Stop syncing a source. Its calendars leave Polaris; nothing is deleted at
 *  the provider. */
export async function removeSource(user: SessionUser, id: string): Promise<void> {
    const source = await ownSource(user, id);
    await prisma.calendarSource.delete({ where: { id: source.id } });
}
