/**
 * ICS subscriptions: conditional fetches, the size cap, webcal links, and the
 * split into one object per UID with a content hash as its etag.
 */

import { describe, expect, it } from "vitest";
import { parseCalendarText } from "@polaris-app/calendar/src/engine";
import {
    HOLIDAY_CALENDARS,
    SyncRefusedError,
    createIcsProvider,
    feedUrl,
    fetchIcsFeed
} from "@polaris-app/calendar/src/lib/sync";

const FEED = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Feed//EN",
    "X-WR-CALNAME:Team schedule",
    "X-APPLE-CALENDAR-COLOR:#FF9500",
    "X-WR-TIMEZONE:Europe/Madrid",
    "BEGIN:VEVENT",
    "UID:one@feed.test",
    "DTSTAMP:20260101T000000Z",
    "DTSTART;TZID=Europe/Madrid:20261001T090000",
    "DTEND;TZID=Europe/Madrid:20261001T100000",
    "RRULE:FREQ=WEEKLY",
    "SUMMARY:Standup",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:one@feed.test",
    "DTSTAMP:20260101T000000Z",
    "RECURRENCE-ID;TZID=Europe/Madrid:20261008T090000",
    "DTSTART;TZID=Europe/Madrid:20261008T110000",
    "DTEND;TZID=Europe/Madrid:20261008T120000",
    "SUMMARY:Standup (late)",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:two@feed.test",
    "DTSTAMP:20260101T000000Z",
    "DTSTART;VALUE=DATE:20261012",
    "DTEND;VALUE=DATE:20261013",
    "SUMMARY:Holiday",
    "END:VEVENT",
    "BEGIN:VTODO",
    "UID:three@feed.test",
    "DTSTAMP:20260101T000000Z",
    "SUMMARY:Task",
    "END:VTODO",
    "END:VCALENDAR",
    ""
].join("\r\n");

function feedServer(body = FEED, etag = '"v1"') {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        seen.push({ url, headers });
        if (headers["If-None-Match"] === etag)
            return new Response(null, { status: 304, headers: { ETag: etag } });
        return new Response(body, {
            status: 200,
            headers: {
                "Content-Type": "text/calendar",
                ETag: etag,
                "Last-Modified": "Wed, 30 Sep 2026 10:00:00 GMT"
            }
        });
    };
    return { fetcher, seen };
}

describe("fetchIcsFeed", () => {
    it("splits a feed into one object per UID, hashed", async () => {
        const { fetcher } = feedServer();
        const result = await fetchIcsFeed({
            url: "https://feeds.example.test/team.ics",
            etag: null,
            lastModified: null,
            fetcher
        });
        if (result.notModified) throw new Error("expected a body");
        expect(result.etag).toBe('"v1"');
        expect(result.lastModified).toBe("Wed, 30 Sep 2026 10:00:00 GMT");
        expect(result.calendar).toEqual({
            name: "Team schedule",
            color: "#FF9500",
            timezone: "Europe/Madrid"
        });
        expect(result.objects.map((o) => o.href).sort()).toEqual([
            "one@feed.test",
            "three@feed.test",
            "two@feed.test"
        ]);
        for (const object of result.objects) expect(object.etag).toMatch(/^[0-9a-f]{64}$/);
        const series = parseCalendarText(
            result.objects.find((o) => o.href === "one@feed.test")!.ics
        ).items[0]!;
        expect(series.component === "VEVENT" && series.overrides.length).toBe(1);

        const again = await fetchIcsFeed({
            url: "https://feeds.example.test/team.ics",
            etag: null,
            lastModified: null,
            fetcher
        });
        if (again.notModified) throw new Error("expected a body");
        expect(again.objects.map((o) => o.etag).sort()).toEqual(
            result.objects.map((o) => o.etag).sort()
        );
    });

    it("sends the stored validators and answers 304 as not modified", async () => {
        const { fetcher, seen } = feedServer();
        const result = await fetchIcsFeed({
            url: "https://feeds.example.test/team.ics",
            etag: '"v1"',
            lastModified: "Wed, 30 Sep 2026 10:00:00 GMT",
            fetcher
        });
        expect(result).toEqual({ notModified: true });
        expect(seen[0]!.headers["If-Modified-Since"]).toBe("Wed, 30 Sep 2026 10:00:00 GMT");
    });

    it("maps webcal:// and webcals:// to https", async () => {
        expect(feedUrl("webcal://feeds.example.test/a.ics")).toBe(
            "https://feeds.example.test/a.ics"
        );
        expect(feedUrl("webcals://feeds.example.test/a.ics")).toBe(
            "https://feeds.example.test/a.ics"
        );
        const { fetcher, seen } = feedServer();
        await fetchIcsFeed({
            url: "webcal://feeds.example.test/team.ics",
            etag: null,
            lastModified: null,
            fetcher
        });
        expect(seen[0]!.url).toBe("https://feeds.example.test/team.ics");
    });

    it("stops reading past the size cap, declared or not", async () => {
        const big = `BEGIN:VCALENDAR\r\n${"X-FILLER:".padEnd(70, "x")}\r\n`.repeat(2000);
        const declared = async () =>
            new Response(big, { status: 200, headers: { "Content-Length": String(big.length) } });
        await expect(
            fetchIcsFeed({
                url: "https://feeds.example.test/big.ics",
                etag: null,
                lastModified: null,
                fetcher: declared,
                maxBytes: 1024
            })
        ).rejects.toBeInstanceOf(SyncRefusedError);

        let pulled = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled++;
                controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
                if (pulled > 10_000) controller.close();
            }
        });
        const streamed = async () => new Response(stream, { status: 200 });
        await expect(
            fetchIcsFeed({
                url: "https://feeds.example.test/endless.ics",
                etag: null,
                lastModified: null,
                fetcher: streamed,
                maxBytes: 64 * 1024
            })
        ).rejects.toBeInstanceOf(SyncRefusedError);
        expect(pulled).toBeLessThan(40);
    });

    it("refuses something that is not a calendar", async () => {
        const html = async () => new Response("<html>login</html>", { status: 200 });
        await expect(
            fetchIcsFeed({
                url: "https://feeds.example.test/x",
                etag: null,
                lastModified: null,
                fetcher: html
            })
        ).rejects.toBeInstanceOf(SyncRefusedError);
    });
});

describe("createIcsProvider", () => {
    it("pulls the whole feed, then nothing while it is unchanged, and refuses writes", async () => {
        const { fetcher } = feedServer();
        const provider = createIcsProvider({
            url: "webcal://feeds.example.test/team.ics",
            fetcher
        });
        const [calendar] = await provider.listCalendars();
        expect(calendar).toMatchObject({
            name: "Team schedule",
            readOnly: true,
            timezone: "Europe/Madrid"
        });
        const first = await provider.pull({
            remoteId: "webcal://feeds.example.test/team.ics",
            syncToken: "",
            ctag: "",
            known: new Map()
        });
        expect(first.full).toBe(true);
        expect(first.changed).toHaveLength(3);
        const second = await provider.pull({
            remoteId: "webcal://feeds.example.test/team.ics",
            syncToken: first.syncToken,
            ctag: first.ctag,
            known: new Map()
        });
        expect(second).toEqual({
            changed: [],
            removed: [],
            syncToken: '"v1"',
            ctag: first.ctag,
            full: false
        });
        await expect(
            provider.put(
                { remoteId: "x" },
                { href: null, etag: null, ics: FEED, uid: "one@feed.test" }
            )
        ).rejects.toBeInstanceOf(SyncRefusedError);
        await expect(
            provider.remove({ remoteId: "x" }, { href: "one@feed.test", etag: null })
        ).rejects.toBeInstanceOf(SyncRefusedError);
    });

    it("downloads once for the listing and the pull of one pass, conditionally on the stored validators", async () => {
        const { fetcher, seen } = feedServer();
        const url = "https://feeds.example.test/team.ics";
        const fresh = createIcsProvider({ url, fetcher, name: "Mine" });
        await fresh.listCalendars();
        const first = await fresh.pull({
            remoteId: url,
            syncToken: "",
            ctag: "",
            known: new Map()
        });
        expect(seen).toHaveLength(1);
        expect(first.changed).toHaveLength(3);

        const next = createIcsProvider({
            url,
            fetcher,
            name: "Mine",
            validators: { etag: first.syncToken, lastModified: first.ctag }
        });
        const [calendar] = await next.listCalendars();
        expect(calendar).toMatchObject({ name: "Mine", timezone: null });
        expect(
            await next.pull({
                remoteId: url,
                syncToken: first.syncToken,
                ctag: first.ctag,
                known: new Map()
            })
        ).toMatchObject({ changed: [], full: false });
        expect(seen).toHaveLength(2);
        expect(seen[1]!.headers["If-None-Match"]).toBe('"v1"');
    });
});

describe("HOLIDAY_CALENDARS", () => {
    it("lists Thunderbird's holiday feeds, as its holiday calendars page names them", () => {
        expect(HOLIDAY_CALENDARS.length).toBeGreaterThan(50);
        for (const entry of HOLIDAY_CALENDARS) {
            expect(entry.url).toMatch(
                /^https:\/\/www\.thunderbird\.net\/media\/caldata\/autogen\/[A-Za-z]+\.ics$/
            );
            expect(entry.region).toMatch(/^[A-Z]{2}$/);
        }
        // Every region and language is one a screen can name in the reader's words.
        const regions = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
        const languages = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
        for (const entry of HOLIDAY_CALENDARS) {
            expect(regions.of(entry.region), entry.name).toBeTruthy();
            expect(languages.of(entry.language), entry.name).toBeTruthy();
        }
        expect(new Set(HOLIDAY_CALENDARS.map((entry) => entry.url)).size).toBe(
            HOLIDAY_CALENDARS.length
        );
    });
});
