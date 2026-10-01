/**
 * Two-way sync between Polaris and the calendars people link.
 *
 * Pull: the `calendar-sync` job asks every source whose interval has come round
 * for what changed since its token (Google's syncToken, a Graph delta link, a
 * CalDAV sync-token or ctag) and writes it through `writeItem` marked as coming
 * from the provider - so it is planned for reminders but never pushed back and
 * never re-sends invitations the provider already sent.
 *
 * Push: a local change to a provider calendar is marked `pendingPush` in the
 * same write, then sent in the background with `If-Match` on the etag Polaris
 * last saw. The screen never waits on the provider. A refusal because the event
 * changed there (412) keeps the provider's version and parks the local one in
 * `conflictIcs` for the person to re-apply; a provider that is down leaves the
 * mark in place and the next pass tries again.
 *
 * Server-only.
 */

import * as sync from "./sync";
import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { calendarTFor } from "./i18n";
import { host } from "@polaris/app-host";
import { userHasPermission } from "@polaris/auth";
import { tryItemOf, writeItem, type StoredObject } from "./objects";

const MINUTE = 60_000;

/** Sources pulled per pass at most; the rest are next. */
const SOURCES_PER_PASS = 20;

/** Pending pushes retried per pass at most. */
const PUSHES_PER_PASS = 100;

const STORED = {
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

type SourceRow = {
    id: string;
    userId: string;
    kind: string;
    label: string;
    connectionId: string | null;
    url: string;
    username: string;
    encryptedSecret: Uint8Array | null;
    secretNonce: Uint8Array | null;
    secretKeyId: string | null;
};

const SOURCE_COLUMNS = {
    id: true,
    userId: true,
    kind: true,
    label: true,
    connectionId: true,
    url: true,
    username: true,
    encryptedSecret: true,
    secretNonce: true,
    secretKeyId: true
} as const;

/** Whether a source's owner may reach addresses on the local network: an
 *  administrator linking a server in their own house. Asked at every pass, so
 *  losing the right stops the reach. */
export async function ownerMayReachLan(userId: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (user?.isAdmin) return true;
    return userHasPermission(userId, "settings.manage");
}

/** The fetch every request of one source goes through. */
export function fetcherFor(allowPrivate: boolean): sync.Fetcher {
    return (url, init) => host.calendarHost.calendarFetch(url, init, { allowPrivate });
}

/**
 * Seal a feed's address like a CalDAV password, keeping only its masked form in
 * the clear. Its calendar is renamed off the address first, so a pass between
 * the two finds it under the id the provider lists.
 */
export async function sealFeedAddress(sourceId: string, address: string): Promise<void> {
    await prisma.calendar.updateMany({
        where: { sourceId, remoteId: { not: sync.FEED_REMOTE_ID } },
        data: { remoteId: sync.FEED_REMOTE_ID }
    });
    const sealed = await host.calendarHost.sealCalendarSecret(sync.feedUrl(address));
    await prisma.calendarSource.update({
        where: { id: sourceId },
        data: { ...sealed, url: sync.maskFeedAddress(address) }
    });
}

/**
 * The address a feed is read from, or null when it needs entering again. One
 * subscribed before addresses were sealed holds it in the clear, and is sealed
 * the first time it is read.
 */
export async function feedAddressOf(
    source: Pick<SourceRow, "id" | "url" | "encryptedSecret" | "secretNonce" | "secretKeyId">
): Promise<string | null> {
    if (source.encryptedSecret) return host.calendarHost.openCalendarSecret(source);
    if (!source.url) return null;
    await sealFeedAddress(source.id, source.url);
    return sync.feedUrl(source.url);
}

/** The protocol client for one source. */
export async function providerFor(source: SourceRow): Promise<sync.CalendarProvider> {
    const fetcher = fetcherFor(await ownerMayReachLan(source.userId));
    switch (source.kind) {
        case "google":
        case "microsoft": {
            const connectionId = source.connectionId;
            if (!connectionId) throw new sync.SyncAuthError("The linked account is gone", null);
            const accessToken = async () => {
                try {
                    return await host.calendarHost.calendarAccessToken(source.userId, connectionId);
                } catch (caught) {
                    if (caught instanceof Error && caught.name === "CalendarLinkExpiredError") {
                        throw new sync.SyncAuthError(
                            "The linked account needs authorizing again",
                            null
                        );
                    }
                    throw caught;
                }
            };
            return source.kind === "google"
                ? sync.createGoogleProvider({ accessToken, fetcher })
                : sync.createGraphProvider({ accessToken, fetcher });
        }
        case "caldav": {
            const password = await host.calendarHost.openCalendarSecret(source);
            if (!password) throw new sync.SyncAuthError("The password needs entering again", null);
            return sync.createCalDavProvider({
                serverUrl: source.url,
                username: source.username,
                password,
                fetcher
            });
        }
        default: {
            const address = await feedAddressOf(source);
            if (!address) throw new sync.SyncAuthError("The address needs entering again", null);
            const held = await prisma.calendar.findFirst({
                where: { sourceId: source.id },
                select: { syncToken: true, ctag: true }
            });
            const validators = held ? { etag: held.syncToken, lastModified: held.ctag } : undefined;
            return sync.createIcsProvider({
                url: address,
                fetcher,
                name: source.label,
                validators
            });
        }
    }
}

/** How a failure is recorded on the source, and what its owner is told. */
function statusFor(caught: unknown): "auth" | "unreachable" | "error" {
    if (caught instanceof sync.SyncAuthError) return "auth";
    if (caught instanceof sync.SyncUnreachableError) return "unreachable";
    if (caught instanceof Error && caught.name === "RefusedAddressError") return "error";
    return "error";
}

/** Record a failed pass, and tell the owner the first time it starts failing. */
async function recordFailure(
    source: { id: string; userId: string; label: string },
    caught: unknown
): Promise<void> {
    const status = statusFor(caught);
    const before = await prisma.calendarSource.findUnique({
        where: { id: source.id },
        select: { status: true }
    });
    await prisma.calendarSource.update({
        where: { id: source.id },
        data: {
            status,
            lastError: caught instanceof sync.SyncError ? caught.message : null,
            nextSyncAt: new Date(Date.now() + (status === "auth" ? 60 : 15) * MINUTE)
        }
    });
    if (before?.status === "ok" && status !== "unreachable") {
        const t = await calendarTFor(source.userId);
        await host.notificationsDispatch
            .notify({
                userId: source.userId,
                event: "calendar.syncFailed",
                title: t("sync.failedTitle", { label: source.label }),
                body: status === "auth" ? t("sync.failedAuth") : t("sync.failedOther"),
                href: "/calendar/settings/accounts"
            })
            .catch(() => undefined);
    }
}

/** Whether a write was refused by a unique key: somebody else wrote the row first. */
function isUniqueClash(caught: unknown): boolean {
    return caught instanceof Error && (caught as { code?: unknown }).code === "P2002";
}

/**
 * Bring a source's list of calendars in step with the provider's: new ones
 * appear, renamed ones follow, ones deleted there leave Polaris too. A feed
 * keeps the name it was subscribed under. A listing with nothing in it removes
 * nothing.
 */
export async function refreshCalendars(
    source: SourceRow,
    provider: sync.CalendarProvider
): Promise<void> {
    const remote = await provider.listCalendars();
    const local = await prisma.calendar.findMany({
        where: { sourceId: source.id },
        select: { id: true, remoteId: true }
    });
    const known = new Map(local.map((calendar) => [calendar.remoteId, calendar.id]));
    const feed = source.kind === "ics";
    for (const calendar of remote) {
        const name = calendar.name.slice(0, 120) || source.label;
        const data = {
            description: calendar.description.slice(0, 2000),
            readOnly: calendar.readOnly || feed,
            components: calendar.components.join(",") || "VEVENT",
            ...(feed && !calendar.timezone
                ? {}
                : { timezone: (calendar.timezone && engine.resolveZone(calendar.timezone)) || "" })
        };
        const id = known.get(calendar.remoteId);
        if (id) {
            await prisma.calendar.update({ where: { id }, data: feed ? data : { ...data, name } });
            continue;
        }
        try {
            await prisma.calendar.create({
                data: {
                    ...data,
                    name,
                    ownerId: source.userId,
                    sourceId: source.id,
                    kind: "remote",
                    remoteId: calendar.remoteId,
                    color:
                        calendar.color && /^#[0-9a-f]{6}$/i.test(calendar.color)
                            ? calendar.color.toLowerCase()
                            : "#3b82f6"
                }
            });
        } catch (caught) {
            if (!isUniqueClash(caught)) throw caught;
            await prisma.calendar.updateMany({
                where: { sourceId: source.id, remoteId: calendar.remoteId },
                data: feed ? data : { ...data, name }
            });
        }
    }
    if (remote.length === 0) return;
    const still = new Set(remote.map((calendar) => calendar.remoteId));
    const gone = local
        .filter((calendar) => !still.has(calendar.remoteId))
        .map((calendar) => calendar.id);
    if (gone.length > 0) await prisma.calendar.deleteMany({ where: { id: { in: gone } } });
}

/** Pull one calendar's changes and store them. */
export async function pullCalendar(
    provider: sync.CalendarProvider,
    calendar: { id: string; remoteId: string; syncToken: string; ctag: string; timezone: string }
): Promise<{ changed: number; removed: number }> {
    const rows = await prisma.calendarObject.findMany({
        where: { calendarId: calendar.id, href: { not: "" } },
        select: { href: true, etag: true, startsAt: true, endsAt: true }
    });
    const known = new Map(rows.map((row) => [row.href, row.etag]));
    let changes: sync.ChangeSet;
    try {
        changes = await provider.pull({
            remoteId: calendar.remoteId,
            syncToken: calendar.syncToken,
            ctag: calendar.ctag,
            known
        });
    } catch (caught) {
        if (!(caught instanceof sync.SyncGoneError)) throw caught;
        // The token expired: start again from nothing, which the provider
        // answers with the whole calendar.
        changes = await provider.pull({
            remoteId: calendar.remoteId,
            syncToken: "",
            ctag: "",
            known
        });
    }

    const zone = calendar.timezone || "UTC";
    let changed = 0;
    for (const remote of changes.changed) {
        const item = tryItemOf(remote.ics);
        if (!item) continue;
        await storeRemote(calendar.id, remote, item, zone);
        changed += 1;
    }

    const removedHrefs = new Set(changes.removed);
    if (changes.full) {
        const present = new Set(changes.changed.map((object) => object.href));
        const window = changes.window;
        const inside = (row: { startsAt: Date | null; endsAt: Date | null }) =>
            !window ||
            (row.startsAt !== null &&
                row.startsAt < window.end &&
                (row.endsAt === null || row.endsAt > window.start));
        for (const row of rows)
            if (!present.has(row.href) && inside(row)) removedHrefs.add(row.href);
    }
    let removed = 0;
    if (removedHrefs.size > 0) {
        const doomed = await prisma.calendarObject.findMany({
            where: { calendarId: calendar.id, href: { in: [...removedHrefs] }, deletedAt: null },
            select: STORED
        });
        for (const row of doomed) {
            // A local change still on its way there is not undone by the pull.
            const pending = await prisma.calendarObject.findUnique({
                where: { id: row.id },
                select: { pendingPush: true }
            });
            if (pending?.pendingPush === "put") continue;
            await prisma.calendarObject.update({
                where: { id: row.id },
                data: { deletedAt: new Date(), pendingPush: "" }
            });
            await (
                await import("./effects")
            ).afterObjectChange({
                objectId: row.id,
                calendarId: row.calendarId,
                before: tryItemOf(row.ics),
                after: null,
                context: { actor: null, floatingZone: zone, fromProvider: true }
            });
            removed += 1;
        }
    }
    await prisma.calendar.update({
        where: { id: calendar.id },
        data: { syncToken: changes.syncToken, ctag: changes.ctag }
    });
    return { changed, removed };
}

/**
 * Store one object as the provider has it. A local change still waiting to be
 * pushed loses to it - the provider is the one every other device reads - and
 * is kept aside so the person can re-apply it.
 */
async function storeRemote(
    calendarId: string,
    remote: sync.RemoteObject,
    item: engine.CalendarItem,
    zone: string
): Promise<void> {
    const existing =
        (await prisma.calendarObject.findFirst({
            where: { calendarId, href: remote.href },
            select: { ...STORED, pendingPush: true }
        })) ??
        (await prisma.calendarObject.findUnique({
            where: { calendarId_uid: { calendarId, uid: item.uid } },
            select: { ...STORED, pendingPush: true }
        }));
    if (existing && existing.etag === remote.etag && !existing.deletedAt) return;
    // A local deletion still on its way is not undone by a pull that lists the
    // event unchanged; one the provider changed since still wins, as a put does.
    if (existing && existing.etag === remote.etag && existing.pendingPush === "delete") return;
    const conflict = existing?.pendingPush === "put" ? existing.ics : null;
    const stored: StoredObject | null = existing
        ? {
              id: existing.id,
              calendarId: existing.calendarId,
              uid: existing.uid,
              component: existing.component,
              ics: existing.ics,
              href: existing.href,
              etag: existing.etag,
              updatedAt: existing.updatedAt,
              deletedAt: existing.deletedAt
          }
        : null;
    const id = await writeItem(calendarId, stored, item, {
        actor: null,
        floatingZone: zone,
        fromProvider: true
    });
    await prisma.calendarObject.update({
        where: { id },
        data: {
            href: remote.href,
            etag: remote.etag,
            pendingPush: "",
            ...(conflict ? { conflictIcs: conflict } : {})
        }
    });
}

/** Pull everything one source has. */
export async function syncSource(sourceId: string, now = new Date()): Promise<void> {
    const source = await prisma.calendarSource.findUnique({
        where: { id: sourceId },
        select: { ...SOURCE_COLUMNS, refreshMinutes: true }
    });
    if (!source) return;
    try {
        const provider = await providerFor(source);
        await refreshCalendars(source, provider);
        const calendars = await prisma.calendar.findMany({
            where: { sourceId: source.id, trashedAt: null },
            select: { id: true, remoteId: true, syncToken: true, ctag: true, timezone: true }
        });
        for (const calendar of calendars) await pullCalendar(provider, calendar);
        await prisma.calendarSource.update({
            where: { id: source.id },
            data: {
                status: "ok",
                lastError: null,
                lastSyncAt: now,
                nextSyncAt: new Date(now.getTime() + source.refreshMinutes * MINUTE)
            }
        });
    } catch (caught) {
        console.error(
            `polaris: calendar source ${source.id} did not sync:`,
            caught instanceof Error ? caught.message : caught
        );
        await recordFailure(source, caught);
    }
}

/**
 * A local change to a provider calendar: marked, then sent in the background.
 * The mark is what makes it survive a restart - the next pass sends it.
 */
export async function pushChange(
    objectId: string,
    sourceId: string,
    removed: boolean
): Promise<void> {
    await prisma.calendarObject.update({
        where: { id: objectId },
        data: { pendingPush: removed ? "delete" : "put" }
    });
    void pushNow(objectId, sourceId).catch((caught: unknown) =>
        console.error(
            "polaris: a calendar change was not pushed yet:",
            caught instanceof Error ? caught.message : caught
        )
    );
}

/** The push running per object: the next one for the same row waits for it, so
 *  two never send one row with the same `If-Match`. */
const pushing = new Map<string, Promise<void>>();

/** Sends one push makes at most while the row keeps changing under it. */
const PUSH_ATTEMPTS = 3;

/** Send one pending change now, after any push of the same object still running. */
export function pushNow(objectId: string, sourceId: string): Promise<void> {
    const previous = pushing.get(objectId) ?? Promise.resolve();
    const run = previous.then(() => pushPending(objectId, sourceId));
    const settled = run.catch(() => undefined);
    pushing.set(objectId, settled);
    void settled.then(() => {
        if (pushing.get(objectId) === settled) pushing.delete(objectId);
    });
    return run;
}

async function pushPending(objectId: string, sourceId: string): Promise<void> {
    for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt += 1) {
        if (await pushOnce(objectId, sourceId)) return;
    }
}

type PushedRow = { id: string; calendarId: string; ics: string; pendingPush: string };

/**
 * Record what the provider now holds. The mark is cleared only while the row is
 * still the version that was sent; one changed meanwhile keeps its mark with
 * the new href and etag, so the next send replaces it with `If-Match` on them.
 * Answers whether the row was still that version.
 */
async function settlePush(
    row: PushedRow,
    held: { href: string; etag: string },
    extra: { conflictIcs?: null } = {}
): Promise<boolean> {
    const settled = await prisma.calendarObject.updateMany({
        where: {
            id: row.id,
            calendarId: row.calendarId,
            ics: row.ics,
            pendingPush: row.pendingPush
        },
        data: { ...held, ...extra, pendingPush: "" }
    });
    if (settled.count > 0) return true;
    await prisma.calendarObject.updateMany({
        where: { id: row.id, calendarId: row.calendarId, pendingPush: { not: "" } },
        data: held
    });
    return false;
}

/** One send of a pending change. Answers whether nothing is left to send. */
async function pushOnce(objectId: string, sourceId: string): Promise<boolean> {
    const row = await prisma.calendarObject.findUnique({
        where: { id: objectId },
        select: {
            ...STORED,
            pendingPush: true,
            calendar: { select: { id: true, remoteId: true, timezone: true } }
        }
    });
    if (!row || !row.pendingPush) return true;
    const source = await prisma.calendarSource.findUnique({
        where: { id: sourceId },
        select: SOURCE_COLUMNS
    });
    if (!source) return true;
    const provider = await providerFor(source);
    const target = { remoteId: row.calendar.remoteId };
    try {
        if (row.pendingPush === "delete") {
            if (row.href) await provider.remove(target, { href: row.href, etag: row.etag || null });
            return await settlePush(row, { href: "", etag: "" });
        }
        const written = await provider.put(target, {
            href: row.href || null,
            etag: row.etag || null,
            ics: row.ics,
            uid: row.uid
        });
        return await settlePush(
            row,
            { href: written.href, etag: written.etag },
            { conflictIcs: null }
        );
    } catch (caught) {
        if (caught instanceof sync.SyncNotFoundError && row.pendingPush === "delete") {
            return await settlePush(row, { href: "", etag: "" });
        }
        if (caught instanceof sync.SyncConflictError) {
            // It changed there first. The pull that follows stores the
            // provider's version and keeps this one aside.
            await pullCalendar(provider, {
                id: row.calendar.id,
                remoteId: row.calendar.remoteId,
                syncToken: "",
                ctag: "",
                timezone: row.calendar.timezone
            });
            return true;
        }
        if (caught instanceof sync.SyncAuthError) await recordFailure(source, caught);
        throw caught;
    }
}

/**
 * Keep the local version the provider refused, or drop it: the conflict banner's
 * two buttons. Re-applying writes it again, which pushes it with the fresh etag.
 */
export async function resolveConflict(
    objectId: string,
    keep: "mine" | "theirs",
    floatingZone: string
): Promise<void> {
    const row = await prisma.calendarObject.findUnique({
        where: { id: objectId },
        select: { ...STORED, conflictIcs: true }
    });
    if (!row?.conflictIcs) return;
    if (keep === "theirs") {
        await prisma.calendarObject.update({ where: { id: row.id }, data: { conflictIcs: null } });
        return;
    }
    const item = tryItemOf(row.conflictIcs);
    await prisma.calendarObject.update({ where: { id: row.id }, data: { conflictIcs: null } });
    if (item) await writeItem(row.calendarId, row, item, { actor: null, floatingZone });
}

/** The scheduled pass: pull what is due, retry what did not push. */
export async function syncDueSources(
    now = new Date()
): Promise<{ pulled: number; pushed: number }> {
    const due = await prisma.calendarSource.findMany({
        where: { nextSyncAt: { lte: now } },
        orderBy: { nextSyncAt: "asc" },
        take: SOURCES_PER_PASS,
        select: { id: true }
    });
    for (const source of due) await syncSource(source.id, now);

    const pending = await prisma.calendarObject.findMany({
        where: { pendingPush: { not: "" }, calendar: { sourceId: { not: null } } },
        select: { id: true, calendar: { select: { sourceId: true } } },
        take: PUSHES_PER_PASS
    });
    let pushed = 0;
    for (const row of pending) {
        if (!row.calendar.sourceId) continue;
        await pushNow(row.id, row.calendar.sourceId)
            .then(() => {
                pushed += 1;
            })
            .catch(() => undefined);
    }
    return { pulled: due.length, pushed };
}
