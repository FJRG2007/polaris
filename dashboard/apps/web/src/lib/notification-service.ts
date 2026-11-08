/**
 * In-app notifications: the bell's storage layer. Rows here are written by the
 * dispatcher (see notifications/dispatch), never directly by feature code, so
 * that an alert cannot skip the account's routing rules. The bell and the
 * notifications page read it. Reads and mutations are always scoped to the
 * owning user, so one user can never see or clear another's notifications.
 * Metadata is stored as a JSON string for the same SQLite-portability reason as
 * the rest of the schema.
 */

import { prisma } from "@polaris/db";
import { shelfFilter } from "@/lib/shelf";
import type { NotificationLevel } from "@polaris/core";

export type { NotificationLevel };

/**
 * Who the alert went to. Deliberately coarse: a recipient learns that others
 * were told, never which accounts, so the feed cannot be used to enumerate users.
 * "group" carries the group name in audienceLabel.
 */
export type NotificationAudience = "you" | "admins" | "group" | "everyone";

export interface NotificationInput {
    userId: string;
    type: string;
    title: string;
    body?: string | null;
    href?: string | null;
    level?: NotificationLevel;
    audience?: NotificationAudience;
    audienceLabel?: string | null;
    actionRequired?: boolean;
    metadata?: Record<string, unknown> | null;
    /**
     * The shelf the alert is filed under: `personal`, an organization's id, or
     * null (the default) for one about the account, shown on every shelf. The
     * dispatcher works this out for the recipient - see `recipientShelf`.
     */
    shelf?: string | null;
    /**
     * Write it already read. For an alert about something the recipient is
     * demonstrably looking at: it belongs in the history, but there is nothing
     * left for a badge to tell them. Decided by the dispatcher, never by the
     * feature raising the alert - see notifications/presence.
     */
    read?: boolean;
    /**
     * What makes this alert the same as an earlier one. Given with `repeat`, a
     * repeat raised inside the window folds into that row - its count goes up
     * and it moves to the top - instead of writing another.
     */
    dedupKey?: string | null;
    /** How repeats and bursts are folded; only read with `dedupKey`. */
    repeat?: RepeatPolicy;
}

/**
 * How the bell folds an alert that keeps being raised.
 *
 * Follows Alertmanager: `windowMs` is its `repeat_interval` (one alert per
 * identity per window; a repeat inside it updates the open one and goes nowhere
 * else), and `burst` is the ceiling on new rows of one event per reader in a
 * short span, past which the rest land on one summary row - the way its
 * group_wait/group_interval turns a storm into one grouped notification.
 */
export interface RepeatPolicy {
    readonly windowMs: number;
    /** Left out for an event that must never be held back (a critical one). */
    readonly burst?: {
        readonly limit: number;
        readonly windowMs: number;
        /** The summary row's text, built only when the ceiling is reached. */
        readonly summary: () => Promise<Pick<NotificationInput, "title" | "body" | "href">>;
    };
}

/** What writing one alert came to: a new row, a repeat folded into an earlier
 *  row, one held on the burst summary, or nothing (the write failed). */
export type NotificationOutcome = "created" | "collapsed" | "held" | "failed";

export interface NotificationView {
    id: string;
    type: string;
    title: string;
    body: string | null;
    href: string | null;
    level: NotificationLevel;
    audience: NotificationAudience;
    audienceLabel: string | null;
    actionRequired: boolean;
    read: boolean;
    /** The latest time it was raised: a folded repeat moves it. */
    createdAt: string;
    /** How many times it was raised while folded into this one row; 1, or left
     *  out, for an alert that never repeated. */
    repeatCount?: number;
    /**
     * The person the alert is about, when it is about one.
     *
     * A notification that somebody added you is drawn with their face rather
     * than with the grey circle every other alert wears - it is news about a
     * person, and a column of identical outlines is a column nobody scans. The
     * id is already recorded in the alert's own metadata (see the friends
     * service); the name is resolved when the list is read rather than copied
     * into the row, because a notification is not a place to keep a stale copy
     * of somebody's name.
     */
    about: { id: string; name: string } | null;
}

const LEVELS: ReadonlySet<string> = new Set(["info", "success", "warning", "danger"]);
const AUDIENCES: ReadonlySet<string> = new Set(["you", "admins", "group", "everyone"]);

const ROW_FIELDS = {
    id: true,
    type: true,
    title: true,
    body: true,
    href: true,
    level: true,
    audience: true,
    audienceLabel: true,
    actionRequired: true,
    metadata: true,
    readAt: true,
    createdAt: true,
    repeatCount: true
} as const;

interface NotificationRow {
    id: string;
    type: string;
    title: string;
    body: string | null;
    href: string | null;
    level: string;
    audience: string;
    audienceLabel: string | null;
    actionRequired: boolean;
    metadata: string | null;
    readAt: Date | null;
    createdAt: Date;
    repeatCount?: number;
}

function toView(row: NotificationRow, names: ReadonlyMap<string, string>): NotificationView {
    const personId = personIn(row.metadata);
    const name = personId ? names.get(personId) : undefined;
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        href: row.href,
        level: (LEVELS.has(row.level) ? row.level : "info") as NotificationLevel,
        audience: (AUDIENCES.has(row.audience) ? row.audience : "you") as NotificationAudience,
        audienceLabel: row.audienceLabel,
        actionRequired: row.actionRequired,
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString(),
        repeatCount: Math.max(1, row.repeatCount ?? 1),
        // Only when the account is still there: a face for somebody who has
        // since been deleted would be a request for a picture that cannot exist.
        about: personId && name !== undefined ? { id: personId, name } : null
    };
}

/** The person an alert is about, from its own metadata. Anything unparseable
 *  reads as "about nobody" rather than failing a list. */
function personIn(metadata: string | null): string | null {
    if (!metadata) return null;
    try {
        const parsed: unknown = JSON.parse(metadata);
        const id = (parsed as { personId?: unknown } | null)?.personId;
        return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
        return null;
    }
}

/** Names for the people a page of alerts is about, in one query rather than one
 *  per row. Empty when no row names anybody, which is most pages. */
async function namesFor(rows: readonly NotificationRow[]): Promise<Map<string, string>> {
    const ids = [
        ...new Set(
            rows.map((row) => personIn(row.metadata)).filter((id): id is string => id !== null)
        )
    ];
    if (ids.length === 0) return new Map();
    const people = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true }
    });
    return new Map(people.map((person) => [person.id, person.name]));
}

function rowData(input: NotificationInput, now: Date) {
    return {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        href: input.href ?? null,
        level: input.level ?? "info",
        audience: input.audience ?? "you",
        audienceLabel: input.audienceLabel ?? null,
        actionRequired: input.actionRequired ?? false,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        shelf: input.shelf ?? null,
        readAt: input.read ? now : null
    };
}

/**
 * Write a notification for a user. Best-effort; never throws to its caller.
 *
 * With a `dedupKey` and a `repeat` policy, a repeat inside the window folds into
 * the row already written: one conditional UPDATE bumps its count and moves it
 * to the top, so the bell shows "x12" rather than twelve lines - and nothing a
 * repeat does can chime, because the client chimes only for an id it has not
 * seen yet.
 */
export async function createNotification(input: NotificationInput): Promise<NotificationOutcome> {
    try {
        const now = new Date();
        if (!input.dedupKey || !input.repeat) {
            await prisma.notification.create({ data: rowData(input, now) });
            return "created";
        }
        const { windowMs, burst } = input.repeat;
        if (await foldRepeat(input, input.dedupKey, windowMs, now)) return "collapsed";
        if (burst && (await overBurst(input.userId, input.type, burst, now))) {
            const summary = { ...input, ...(await burst.summary()) };
            const outcome = await writeRepeatable(summary, `burst:${input.type}`, windowMs, now);
            return outcome === "failed" ? "failed" : "held";
        }
        return await writeRepeatable(input, input.dedupKey, windowMs, now);
    } catch {
        // A notification failing must not break the action that triggered it.
        return "failed";
    }
}

/**
 * Which row of a key a repeat may fold into: one first raised inside the window
 * and still unread. Once the reader has read it, the next repeat is news again
 * and gets a row of its own - otherwise dismissing an alert would hide every
 * repeat for the rest of the hour. A repeat that is itself written read (the
 * page it points at is open, or it is muted) tells nobody anything either way,
 * so it folds into the row whatever its state.
 */
function foldable(input: NotificationInput, windowMs: number, now: Date) {
    return {
        firstSeenAt: { gte: new Date(now.getTime() - windowMs) },
        ...(input.read ? {} : { readAt: null })
    };
}

/**
 * Fold a repeat into the foldable row for its key. A single conditional UPDATE,
 * so two processes folding at once each add one. The latest text wins, as it
 * does for a condition; whether it was read is left as the reader left it.
 */
async function foldRepeat(
    input: NotificationInput,
    dedupKey: string,
    windowMs: number,
    now: Date
): Promise<boolean> {
    const done = await prisma.notification.updateMany({
        where: { userId: input.userId, dedupKey, ...foldable(input, windowMs, now) },
        data: {
            title: input.title,
            body: input.body ?? null,
            ...(input.href !== undefined ? { href: input.href } : {}),
            level: input.level ?? "info",
            metadata: input.metadata ? JSON.stringify(input.metadata) : null,
            repeatCount: { increment: 1 },
            createdAt: now,
            updatedAt: now
        }
    });
    return done.count > 0;
}

/**
 * A new row for a key no foldable row holds. A row still carrying the key that
 * cannot be folded into - first raised before the window, or already read -
 * gives it up first (it stays on the bell as it was, count and all), so the
 * unique index - one row per key per reader - has room for this one. Only such
 * a row: a fresh one another process wrote a moment ago is left holding its
 * key, so this create hits the index and folds into it instead of the two
 * racing processes ending in two rows.
 */
async function writeRepeatable(
    input: NotificationInput,
    dedupKey: string,
    windowMs: number,
    now: Date
): Promise<NotificationOutcome> {
    if (await foldRepeat(input, dedupKey, windowMs, now)) return "collapsed";
    const cutoff = new Date(now.getTime() - windowMs);
    await prisma.notification.updateMany({
        where: {
            userId: input.userId,
            dedupKey,
            OR: [
                { firstSeenAt: null },
                { firstSeenAt: { lt: cutoff } },
                ...(input.read ? [] : [{ readAt: { not: null } }])
            ]
        },
        data: { dedupKey: null }
    });
    try {
        await prisma.notification.create({
            data: { ...rowData(input, now), dedupKey, firstSeenAt: now, repeatCount: 1 }
        });
        return "created";
    } catch (caught) {
        if (isUniqueViolation(caught) && (await foldRepeat(input, dedupKey, windowMs, now)))
            return "collapsed";
        throw caught;
    }
}

/** Whether this reader already got `limit` new rows of this event inside the
 *  burst window. Bounded by the limit, on the (userId, createdAt) index. A count
 *  that cannot be read never holds anything back. */
async function overBurst(
    userId: string,
    type: string,
    burst: NonNullable<RepeatPolicy["burst"]>,
    now: Date
): Promise<boolean> {
    try {
        const recent = await prisma.notification.count({
            where: { userId, type, createdAt: { gte: new Date(now.getTime() - burst.windowMs) } },
            take: burst.limit
        });
        return recent >= burst.limit;
    } catch {
        return false;
    }
}

/** What raising a condition came to: a new notice, the open one rewritten, or nothing. */
export type ConditionOutcome = "created" | "updated" | "failed";

/** The text a condition's notice is rewritten with. */
type ConditionText = Pick<
    NotificationInput,
    "title" | "body" | "href" | "level" | "actionRequired" | "metadata"
>;

function conditionText(input: ConditionText): Record<string, unknown> {
    return {
        title: input.title,
        body: input.body ?? null,
        ...(input.href !== undefined ? { href: input.href } : {}),
        level: input.level ?? "info",
        actionRequired: input.actionRequired ?? false,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        updatedAt: new Date()
    };
}

/** Prisma's unique-constraint violation: somebody else wrote the row first. */
function isUniqueViolation(caught: unknown): boolean {
    return (
        typeof caught === "object" &&
        caught !== null &&
        (caught as { code?: unknown }).code === "P2002"
    );
}

/**
 * Raise an ongoing condition for one reader: a new notice the first time, and
 * the same notice rewritten in place on every later call while the condition
 * holds - no new row, and the read state is left as the reader left it, so a
 * checker running every ten minutes is one line on the bell, not one an hour.
 * `resurface` puts a rewritten notice back to unread, for when the condition
 * got worse (a second address failing) rather than merely still holding.
 *
 * Safe under concurrent callers: the key is unique per reader, so of two raises
 * racing to create, one creates and the other finds that row and updates it.
 */
export async function raiseCondition(
    conditionKey: string,
    input: NotificationInput,
    options: { resurface?: boolean } = {}
): Promise<ConditionOutcome> {
    const rewrite = async (): Promise<boolean> => {
        const done = await prisma.notification.updateMany({
            where: { userId: input.userId, conditionKey },
            data: { ...conditionText(input), ...(options.resurface ? { readAt: null } : {}) }
        });
        return done.count > 0;
    };
    try {
        if (await rewrite()) return "updated";
        try {
            await prisma.notification.create({
                data: {
                    userId: input.userId,
                    type: input.type,
                    title: input.title,
                    body: input.body ?? null,
                    href: input.href ?? null,
                    level: input.level ?? "info",
                    audience: input.audience ?? "you",
                    audienceLabel: input.audienceLabel ?? null,
                    actionRequired: input.actionRequired ?? false,
                    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
                    shelf: input.shelf ?? null,
                    conditionKey,
                    readAt: input.read ? new Date() : null
                }
            });
            return "created";
        } catch (caught) {
            if (isUniqueViolation(caught) && (await rewrite())) return "updated";
            throw caught;
        }
    } catch {
        // Like createNotification: an alert failing never breaks the checker.
        return "failed";
    }
}

/**
 * End a condition: its open notice is marked read and no longer waiting on
 * anybody, and loses its key, so the next time the condition starts it is a new
 * notice. `recovery` rewrites the text ("answers again") instead of adding a
 * second row for the good news. `userIds` narrows it to those readers; left
 * out, the condition ends for everyone it was raised for (an instance-wide one).
 * Returns how many notices it closed.
 */
export async function resolveCondition(
    conditionKey: string,
    options: { userIds?: readonly string[]; recovery?: ConditionText } = {}
): Promise<number> {
    try {
        const done = await prisma.notification.updateMany({
            where: {
                conditionKey,
                ...(options.userIds ? { userId: { in: [...options.userIds] } } : {})
            },
            data: {
                ...(options.recovery ? conditionText(options.recovery) : { updatedAt: new Date() }),
                conditionKey: null,
                readAt: new Date(),
                actionRequired: false
            }
        });
        return done.count;
    } catch {
        return 0;
    }
}

/** An open condition as a checker reads it back. */
export interface OpenCondition {
    conditionKey: string;
    type: string;
    metadata: Record<string, unknown>;
}

/** The conditions still open for one reader under a key prefix, for a checker
 *  that has to tell which of its conditions a recovery ends. */
export async function openConditions(userId: string, prefix: string): Promise<OpenCondition[]> {
    let rows: Array<{ conditionKey: string | null; type: string; metadata: string | null }>;
    try {
        rows = await prisma.notification.findMany({
            where: { userId, conditionKey: { startsWith: prefix } },
            select: { conditionKey: true, type: true, metadata: true },
            take: 500
        });
    } catch {
        return [];
    }
    return rows.flatMap((row) => {
        if (!row.conditionKey) return [];
        let metadata: Record<string, unknown> = {};
        try {
            const parsed: unknown = row.metadata ? JSON.parse(row.metadata) : null;
            if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
        } catch {
            // Unreadable metadata names no members; the notice is still open.
        }
        return [{ conditionKey: row.conditionKey, type: row.type, metadata }];
    });
}

/** How many notifications the live feed carries. The bell and the page share it,
 *  so there is a single list to keep in sync rather than two. */
export const NOTIFICATION_FEED_LIMIT = 50;

/**
 * A user's notifications on the open shelf, newest first.
 *
 * The shelf is required rather than defaulted, for the reason Mail's listings
 * take it: a feed that forgot it looks like a feed that works, and it is the
 * bell counting a company's alerts for somebody looking at their own shelf.
 */
export async function listNotifications(
    userId: string,
    shelf: string,
    limit = NOTIFICATION_FEED_LIMIT
): Promise<NotificationView[]> {
    const rows = await prisma.notification.findMany({
        where: { userId, ...shelfFilter(shelf) },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: ROW_FIELDS
    });
    const names = await namesFor(rows);
    return rows.map((row) => toView(row, names));
}

/**
 * A fingerprint of a user's feed on one shelf that moves whenever the list
 * `listNotifications` would return could have moved - one aggregate, no rows.
 *
 * Every write to the table is one of: a row created (the newest `createdAt`
 * and the count move), a row deleted (the count moves), or a row marked read,
 * which is always stamped with the time it happened - including the clearing
 * of "Action needed", which sets `readAt` alongside it - so the latest
 * `readAt` moves. A condition rewriting its notice in place stamps `updatedAt`,
 * which is read here too. What this cannot see is
 * a name changing on the person an alert is about; the stream re-reads the list
 * on a slower clock for that.
 */
export async function notificationFeedVersion(userId: string, shelf: string): Promise<string> {
    const probe = await prisma.notification.aggregate({
        where: { userId, ...shelfFilter(shelf) },
        _count: { _all: true },
        _max: { createdAt: true, readAt: true, updatedAt: true }
    });
    return [
        probe._count._all,
        probe._max.createdAt?.getTime() ?? 0,
        probe._max.readAt?.getTime() ?? 0,
        probe._max.updatedAt?.getTime() ?? 0
    ].join(":");
}

/** How many rows one page of the history holds. */
export const NOTIFICATION_PAGE_SIZE = 40;

/** One page of history, oldest cursor last. */
export interface NotificationPage {
    items: NotificationView[];
    /** Pass back as `before` to get the next page. Null when the list ended. */
    cursor: string | null;
}

/**
 * A page of a user's notifications, newest first. Unlike the live feed this
 * reaches back through everything ever raised, so the page can answer "what
 * happened last Tuesday" rather than only "what is recent".
 */
export async function listNotificationHistory(
    userId: string,
    shelf: string,
    options: { before?: string | null; event?: string | null; unreadOnly?: boolean } = {}
): Promise<NotificationPage> {
    const rows = await prisma.notification.findMany({
        where: {
            userId,
            ...shelfFilter(shelf),
            ...(options.before ? { createdAt: { lt: new Date(options.before) } } : {}),
            ...(options.event ? { type: options.event } : {}),
            ...(options.unreadOnly ? { readAt: null } : {})
        },
        orderBy: { createdAt: "desc" },
        take: NOTIFICATION_PAGE_SIZE + 1,
        select: ROW_FIELDS
    });
    const page = rows.slice(0, NOTIFICATION_PAGE_SIZE);
    const names = await namesFor(page);
    return {
        items: page.map((row) => toView(row, names)),
        cursor:
            rows.length > NOTIFICATION_PAGE_SIZE
                ? (page.at(-1)?.createdAt.toISOString() ?? null)
                : null
    };
}

/** One attempt to get one alert somewhere, as the history renders it. */
export interface DeliveryView {
    id: string;
    event: string;
    kind: string;
    destinationHint: string | null;
    status: string;
    detail: string | null;
    createdAt: string;
}

/**
 * The recent delivery attempts for a user. This is what answers "the alarm
 * fired, so why did nobody get a text" - the bell alone cannot distinguish a
 * muted rule from a webhook that has been 404ing for a week.
 */
export async function listDeliveries(userId: string, limit = 100): Promise<DeliveryView[]> {
    const rows = await prisma.notificationDelivery.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
            id: true,
            event: true,
            kind: true,
            destinationHint: true,
            status: true,
            detail: true,
            createdAt: true
        }
    });
    return rows.map((row) => ({
        id: row.id,
        event: row.event,
        kind: row.kind,
        destinationHint: row.destinationHint,
        status: row.status,
        detail: row.detail,
        createdAt: row.createdAt.toISOString()
    }));
}

/** Mark one notification read (scoped to the owner). */
export async function markNotificationRead(userId: string, id: string): Promise<void> {
    await prisma.notification.updateMany({
        where: { id, userId, readAt: null },
        data: { readAt: new Date() }
    });
}

/** Mark every unread notification on the open shelf read - the ones the bell
 *  is showing, and not a company's that nobody on this shelf has looked at. */
export async function markAllNotificationsRead(userId: string, shelf: string): Promise<void> {
    await prisma.notification.updateMany({
        where: { userId, readAt: null, ...shelfFilter(shelf) },
        data: { readAt: new Date() }
    });
}

/**
 * Mark every unread notification of these types read, for everyone.
 *
 * The one exception to the per-user scoping above, and deliberately so: some
 * alerts describe a state of the deployment rather than of an account, and when
 * that state resolves the alert is answered rather than ignored. An update that
 * has been installed cannot be installed again, so leaving its announcement
 * unread would hand every operator a bell to empty by hand after each release.
 * The condition being cleared belongs to the instance, so the clearing does too.
 * `userIds` narrows it to those readers, for an alert being replaced only for
 * some of them.
 */
export async function markNotificationsReadByType(
    types: readonly string[],
    userIds?: readonly string[]
): Promise<void> {
    await prisma.notification.updateMany({
        // Either half is worth clearing on its own: one that was read but still
        // says "Action needed" is a chore the reader cannot get rid of, and one
        // still unread is a count on the bell for something already done.
        where: {
            type: { in: [...types] },
            ...(userIds ? { userId: { in: [...userIds] } } : {}),
            OR: [{ readAt: null }, { actionRequired: true }]
        },
        // Read AND no longer waiting on anybody. These are answered by something
        // that happened - an update installed, a permission granted - rather than
        // by being looked at, and "Action needed" left standing after the action
        // was taken is the alert nobody can clear because nothing is wrong.
        data: { readAt: new Date(), actionRequired: false }
    });
}

/**
 * Take alerts of these types off the bell altogether, for every reader or only
 * `userIds`. For an alert that is superseded rather than answered: marked read,
 * it still sits in the list, and one a build is one more line saying something
 * no longer true - a day of merges was a bell of fifty.
 */
export async function deleteNotificationsByType(
    types: readonly string[],
    userIds?: readonly string[]
): Promise<void> {
    await prisma.notification.deleteMany({
        where: {
            type: { in: [...types] },
            ...(userIds ? { userId: { in: [...userIds] } } : {})
        }
    });
}

/** Mark a chosen set read. Scoped to the owner, so ids that arrive from a
 *  browser and belong to somebody else are simply not matched. */
export async function markNotificationsRead(
    userId: string,
    ids: readonly string[]
): Promise<number> {
    if (ids.length === 0) return 0;
    const done = await prisma.notification.updateMany({
        where: { id: { in: [...ids] }, userId, readAt: null },
        data: { readAt: new Date() }
    });
    return done.count;
}

/** Delete a chosen set (scoped to the owner). */
export async function deleteNotifications(userId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const gone = await prisma.notification.deleteMany({ where: { id: { in: [...ids] }, userId } });
    return gone.count;
}

/** Delete one notification (scoped to the owner). */
export async function deleteNotification(userId: string, id: string): Promise<void> {
    await prisma.notification.deleteMany({ where: { id, userId } });
}

/** Delete every notification on the open shelf, for the same reason reading
 *  them all stops there. */
export async function clearNotifications(userId: string, shelf: string): Promise<void> {
    await prisma.notification.deleteMany({ where: { userId, ...shelfFilter(shelf) } });
}
