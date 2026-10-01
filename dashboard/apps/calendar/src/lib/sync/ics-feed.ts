/**
 * ICS subscriptions: a calendar published as one `.ics` file at a URL -
 * Proton's share links, holiday calendars, a team's published schedule.
 *
 * Read-only by nature. Each fetch sends the ETag and Last-Modified of the last
 * one, so an unchanged feed costs a 304 and nothing else; a changed feed is
 * split into one object per UID, each with a content hash as its etag, so the
 * sync engine rewrites only what actually changed. The body is read with a cap:
 * a feed is a URL someone typed, and it may be anything.
 */

import * as engine from "../../engine";
import { SyncRefusedError } from "./errors";
import type { CalendarProvider, RemoteObject } from "./provider";
import { errorFor, readCapped, reasonOf, send, sha256Hex, type Fetcher } from "./http";

/** The largest feed read by default: bigger than any real calendar, smaller than harm. */
export const DEFAULT_FEED_BYTES = 10 * 1024 * 1024;

/** `webcal://` and `webcals://` are http(s) by another name. */
export function feedUrl(raw: string): string {
    const trimmed = raw.trim();
    if (/^webcals:\/\//i.test(trimmed)) return `https://${trimmed.slice(10)}`;
    if (/^webcal:\/\//i.test(trimmed)) return `https://${trimmed.slice(9)}`;
    return trimmed;
}

/**
 * The id a feed's one calendar is stored under. Not the address: a private
 * feed's address is the secret that reads it, and is kept sealed.
 */
export const FEED_REMOTE_ID = "feed";

/** Characters of a feed's address shown after its host, so two can be told apart. */
const MASKED_TAIL = 4;

/** A feed's address as it may be shown: its host and the last few characters. */
export function maskFeedAddress(raw: string): string {
    const address = feedUrl(raw);
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return `...${address.slice(-MASKED_TAIL)}`;
    }
    const rest = `${url.pathname}${url.search}`;
    if (rest.length <= 1) return `${url.protocol}//${url.host}`;
    return `${url.protocol}//${url.host}/...${rest.slice(-MASKED_TAIL)}`;
}

export type FeedResult =
    | { notModified: true }
    | {
          notModified: false;
          etag: string | null;
          lastModified: string | null;
          calendar: { name: string | null; color: string | null; timezone: string | null };
          objects: RemoteObject[];
      };

/**
 * Fetches a feed, conditionally on the last copy.
 *
 * `webcal://` is fetched over https: the scheme predates TLS being the norm and
 * every publisher serves it there. Throws `SyncRefusedError` past `maxBytes`
 * and for something that is not a calendar.
 */
export async function fetchIcsFeed(input: {
    url: string;
    etag: string | null;
    lastModified: string | null;
    fetcher: Fetcher;
    maxBytes?: number;
}): Promise<FeedResult> {
    const headers: Record<string, string> = { Accept: "text/calendar, text/plain;q=0.8, */*;q=0.5" };
    if (input.etag) headers["If-None-Match"] = input.etag;
    if (input.lastModified) headers["If-Modified-Since"] = input.lastModified;
    const { response } = await send(input.fetcher, feedUrl(input.url), { headers });
    if (response.status === 304) {
        await response.body?.cancel().catch(() => undefined);
        return { notModified: true };
    }
    if (!response.ok) throw errorFor(response, await reasonOf(response));
    const text = await readCapped(response, input.maxBytes ?? DEFAULT_FEED_BYTES);
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new SyncRefusedError("The address did not return a calendar", response.status);
    const parsed = engine.parseCalendarText(text);
    const objects: RemoteObject[] = [];
    for (const item of parsed.items) {
        const ics = engine.serializeItem(item, {});
        objects.push({ href: item.uid, etag: await sha256Hex(ics), ics });
    }
    return {
        notModified: false,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        calendar: { name: parsed.name ?? null, color: parsed.color ?? null, timezone: parsed.timezone ?? null },
        objects
    };
}

/**
 * A feed as a `CalendarProvider`: one calendar, pulled whole every time it
 * changed, never written.
 *
 * The feed's own ETag and Last-Modified travel in the sync state's `syncToken`
 * and `ctag`, so a pull of an unchanged feed is a 304. `validators` are the
 * stored ones, so listing the calendar and pulling it in the same pass is one
 * conditional download.
 */
export function createIcsProvider(input: {
    url: string;
    fetcher: Fetcher;
    maxBytes?: number;
    name?: string;
    validators?: { etag: string; lastModified: string };
}): CalendarProvider {
    let last: { key: string; result: Promise<FeedResult> } | null = null;
    const fetchOnce = (etag: string, lastModified: string): Promise<FeedResult> => {
        const key = JSON.stringify([etag, lastModified]);
        if (last?.key === key) return last.result;
        const result = fetchIcsFeed({ url: input.url, etag: etag || null, lastModified: lastModified || null, fetcher: input.fetcher, maxBytes: input.maxBytes });
        last = { key, result };
        return result;
    };

    return {
        async listCalendars() {
            const result = await fetchOnce(input.validators?.etag ?? "", input.validators?.lastModified ?? "");
            const calendar = result.notModified ? null : result.calendar;
            return [
                {
                    remoteId: FEED_REMOTE_ID,
                    name: calendar?.name ?? input.name ?? "",
                    color: calendar?.color ?? null,
                    description: "",
                    timezone: calendar?.timezone ?? null,
                    readOnly: true,
                    components: ["VEVENT", "VTODO"]
                }
            ];
        },

        async pull(state) {
            const result = await fetchOnce(state.syncToken, state.ctag);
            if (result.notModified) return { changed: [], removed: [], syncToken: state.syncToken, ctag: state.ctag, full: false };
            return { changed: result.objects, removed: [], syncToken: result.etag ?? "", ctag: result.lastModified ?? "", full: true };
        },

        async put() {
            throw new SyncRefusedError("A subscribed calendar cannot be changed", null);
        },

        async remove() {
            throw new SyncRefusedError("A subscribed calendar cannot be changed", null);
        }
    };
}
