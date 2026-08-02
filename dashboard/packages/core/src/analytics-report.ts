/**
 * Turning recorded visits into the numbers an analytics screen shows.
 *
 * Pure, and separate from where the rows came from, because there are two sources
 * that must agree: the edge's access log (every deployed service, no setup, no
 * script) and the tracker (duration, screen size, custom events). If either one
 * counted differently the two halves of a screen would contradict each other, so
 * both are folded here.
 *
 * The vocabulary is worth being exact about, because analytics tools disagree:
 *
 * - a *view* is one pageview
 * - a *session* is one visit - one person, one sitting
 * - a *visitor* is a distinct session, because sessions are cookieless and rotate
 *   daily: over one day the two are the same number, over a week "visitors" means
 *   daily-unique visitors and is honestly reported as such rather than deduplicated
 *   across days by an identity nobody is tracking
 * - a *bounce* is a session that saw exactly one page
 */

export interface VisitSessionRow {
    readonly id: string;
    /** Epoch ms. */
    readonly startedAt: number;
    readonly lastSeenAt: number;
    readonly views: number;
    readonly ip: string | null;
    readonly browser: string;
    readonly os: string;
    readonly device: string;
    readonly country: string | null;
    readonly language: string | null;
    readonly screen: string | null;
    readonly referrerKind: string;
    readonly referrerSource: string | null;
    readonly campaign: string | null;
    readonly medium: string | null;
}

export interface VisitEventRow {
    readonly sessionId: string;
    /** Epoch ms. */
    readonly at: number;
    readonly kind: "pageview" | "event";
    /** Custom event name; null for a pageview. */
    readonly name: string | null;
    /** The grouped route. */
    readonly path: string;
}

export interface VisitOverview {
    readonly visitors: number;
    readonly sessions: number;
    readonly views: number;
    readonly events: number;
    /** 0..1, or null when there were no sessions to divide by. */
    readonly bounceRate: number | null;
    /** Mean session length in seconds, over the sessions long enough to have one.
     *  Null when none did - a screen that shows "0s" for an unmeasured visit is
     *  claiming something it does not know. */
    readonly avgVisitSec: number | null;
    readonly viewsPerSession: number | null;
}

export interface VisitPoint {
    /** Bucket start, epoch ms. */
    readonly t: number;
    readonly visitors: number;
    readonly views: number;
}

export interface VisitRow {
    readonly key: string;
    readonly visitors: number;
    readonly views: number;
}

export const VISIT_DIMENSIONS = [
    "path",
    "entry",
    "exit",
    "referrer",
    "channel",
    "campaign",
    "browser",
    "os",
    "device",
    "country",
    "language",
    "screen",
    "event",
    "ip"
] as const;
export type VisitDimension = (typeof VISIT_DIMENSIONS)[number];

export interface VisitReport {
    readonly overview: VisitOverview;
    readonly series: readonly VisitPoint[];
    readonly breakdowns: Readonly<Record<VisitDimension, readonly VisitRow[]>>;
}

export interface VisitReportInput {
    readonly sessions: readonly VisitSessionRow[];
    readonly events: readonly VisitEventRow[];
    /** Window, epoch ms. Sessions and events outside it are ignored, so the caller
     *  can hand over a generous read and narrow it here. */
    readonly from: number;
    readonly to: number;
    readonly buckets?: number;
    /** Rows per breakdown. */
    readonly limit?: number;
}

const DEFAULT_BUCKETS = 24;
const DEFAULT_LIMIT = 10;

/** Everything one screen needs, in a single pass over the rows. */
export function reportVisits(input: VisitReportInput): VisitReport {
    const { from, to } = input;
    const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 500));
    const events = input.events.filter((event) => event.at >= from && event.at < to);

    // A session counts when any of its activity lands in the window - clipping on
    // startedAt alone would drop the visit that began just before it and is the
    // reason there is traffic at all.
    const touched = new Set(events.map((event) => event.sessionId));
    const sessions = input.sessions.filter(
        (session) => touched.has(session.id) || (session.lastSeenAt >= from && session.startedAt < to)
    );

    return {
        overview: overviewOf(sessions, events),
        series: seriesOf(events, from, to, input.buckets ?? DEFAULT_BUCKETS),
        breakdowns: breakdownsOf(sessions, events, limit)
    };
}

function overviewOf(sessions: readonly VisitSessionRow[], events: readonly VisitEventRow[]): VisitOverview {
    const views = events.filter((event) => event.kind === "pageview").length;
    const custom = events.length - views;

    // Counted from the events in the window rather than from session.views, which is
    // the session's lifetime total and would overstate a narrow window.
    const perSession = new Map<string, number>();
    for (const event of events) {
        if (event.kind !== "pageview") continue;
        perSession.set(event.sessionId, (perSession.get(event.sessionId) ?? 0) + 1);
    }

    let bounced = 0;
    let durationSum = 0;
    let durationCount = 0;
    for (const session of sessions) {
        if ((perSession.get(session.id) ?? session.views) <= 1) bounced += 1;
        const length = session.lastSeenAt - session.startedAt;
        if (length > 0) {
            durationSum += length;
            durationCount += 1;
        }
    }

    return {
        visitors: sessions.length,
        sessions: sessions.length,
        views,
        events: custom,
        bounceRate: sessions.length > 0 ? bounced / sessions.length : null,
        avgVisitSec: durationCount > 0 ? Math.round(durationSum / durationCount / 1000) : null,
        viewsPerSession: sessions.length > 0 ? views / sessions.length : null
    };
}

function seriesOf(events: readonly VisitEventRow[], from: number, to: number, buckets: number): VisitPoint[] {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
    const count = Math.max(1, Math.min(Math.floor(buckets), 500));
    const width = (to - from) / count;
    const slots = Array.from({ length: count }, (_, index) => ({
        t: Math.round(from + index * width),
        views: 0,
        seen: new Set<string>()
    }));

    for (const event of events) {
        const slot = slots[Math.min(count - 1, Math.floor((event.at - from) / width))];
        if (!slot) continue;
        // A visitor counts in every bucket they were active in. Attributing them only
        // to their first would draw a chart where a long visit looks like it stopped.
        slot.seen.add(event.sessionId);
        if (event.kind === "pageview") slot.views += 1;
    }
    return slots.map((slot) => ({ t: slot.t, views: slot.views, visitors: slot.seen.size }));
}

/**
 * Every breakdown at once.
 *
 * A dimension that lives on the session (browser, country, where they came from) is
 * counted per session and its views summed from that session's events; a dimension
 * that lives on the event (path, event name) is counted per event with the distinct
 * sessions behind it. Mixing the two up is how a "top pages" list ends up with more
 * visitors than the site had.
 */
function breakdownsOf(
    sessions: readonly VisitSessionRow[],
    events: readonly VisitEventRow[],
    limit: number
): Record<VisitDimension, VisitRow[]> {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const viewsPerSession = new Map<string, number>();
    const first = new Map<string, VisitEventRow>();
    const last = new Map<string, VisitEventRow>();

    const paths = new Tally();
    const eventNames = new Tally();

    for (const event of events) {
        if (!byId.has(event.sessionId)) continue;
        if (event.kind === "pageview") {
            viewsPerSession.set(event.sessionId, (viewsPerSession.get(event.sessionId) ?? 0) + 1);
            paths.add(event.path, event.sessionId, 1);
            const seenFirst = first.get(event.sessionId);
            if (!seenFirst || event.at < seenFirst.at) first.set(event.sessionId, event);
            const seenLast = last.get(event.sessionId);
            if (!seenLast || event.at >= seenLast.at) last.set(event.sessionId, event);
        } else if (event.name) {
            eventNames.add(event.name, event.sessionId, 1);
        }
    }

    const entry = new Tally();
    const exit = new Tally();
    for (const [sessionId, event] of first) entry.add(event.path, sessionId, 1);
    for (const [sessionId, event] of last) exit.add(event.path, sessionId, 1);

    const referrer = new Tally();
    const channel = new Tally();
    const campaign = new Tally();
    const browser = new Tally();
    const os = new Tally();
    const device = new Tally();
    const country = new Tally();
    const language = new Tally();
    const screen = new Tally();
    const ip = new Tally();

    for (const session of sessions) {
        const views = viewsPerSession.get(session.id) ?? 0;
        // "Direct" is a real answer, not a missing one - so it gets a row rather than
        // being dropped, which would make the referrer list add up to less than the
        // traffic and read as a gap in the data.
        referrer.add(session.referrerSource ?? "Direct", session.id, views);
        channel.add(session.referrerKind, session.id, views);
        if (session.campaign) campaign.add(session.campaign, session.id, views);
        browser.add(session.browser, session.id, views);
        os.add(session.os, session.id, views);
        device.add(session.device, session.id, views);
        if (session.country) country.add(session.country, session.id, views);
        if (session.language) language.add(session.language, session.id, views);
        if (session.screen) screen.add(session.screen, session.id, views);
        if (session.ip) ip.add(session.ip, session.id, views);
    }

    return {
        path: paths.top(limit),
        entry: entry.top(limit),
        exit: exit.top(limit),
        referrer: referrer.top(limit),
        channel: channel.top(limit),
        campaign: campaign.top(limit),
        browser: browser.top(limit),
        os: os.top(limit),
        device: device.top(limit),
        country: country.top(limit),
        language: language.top(limit),
        screen: screen.top(limit),
        event: eventNames.top(limit),
        ip: ip.top(limit)
    };
}

/** Views summed and distinct sessions counted, per key. */
class Tally {
    private readonly cells = new Map<string, { views: number; sessions: Set<string> }>();

    add(key: string, sessionId: string, views: number): void {
        let cell = this.cells.get(key);
        if (!cell) {
            cell = { views: 0, sessions: new Set() };
            this.cells.set(key, cell);
        }
        cell.views += views;
        cell.sessions.add(sessionId);
    }

    top(limit: number): VisitRow[] {
        return [...this.cells]
            .map(([key, cell]) => ({ key, visitors: cell.sessions.size, views: cell.views }))
            // Visitors first, views to break the tie, then the key so the order of two
            // identical rows does not shuffle between reloads.
            .sort((a, b) => b.visitors - a.visitors || b.views - a.views || (a.key < b.key ? -1 : 1))
            .slice(0, limit);
    }
}

/**
 * The session identifier for a visit.
 *
 * Cookieless, the way Umami does it: a hash of the salt, the site, the address and
 * the user agent. The salt rotates daily, so the same visitor tomorrow is a
 * different session and nothing follows anyone between days - which is what makes
 * this need no consent banner. It also means the hash cannot be reversed into an
 * address after the salt has turned over.
 *
 * Async because it uses the platform's own crypto rather than a dependency.
 */
export async function visitSessionId(input: {
    salt: string;
    siteId: string;
    ip: string;
    userAgent: string;
}): Promise<string> {
    const material = `${input.salt}:${input.siteId}:${input.ip}:${input.userAgent}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    return [...new Uint8Array(digest)]
        .slice(0, 16)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/** The UTC day a timestamp falls in, as an epoch-ms midnight. What the daily salt
 *  and the rollup are both keyed on. */
export function visitDay(at: number): number {
    return Math.floor(at / 86_400_000) * 86_400_000;
}
