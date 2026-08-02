import { describe, expect, it } from "vitest";
import { countryFlag, countryForTimeZone, countryName, parseLanguage, resolveCountry } from "../src/analytics-geo.js";
import {
    reportVisits,
    visitDay,
    visitSessionId,
    type VisitEventRow,
    type VisitSessionRow
} from "../src/analytics-report.js";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
const FROM = NOW - 24 * HOUR;

function session(id: string, over: Partial<VisitSessionRow> = {}): VisitSessionRow {
    return {
        id,
        startedAt: NOW - 2 * HOUR,
        lastSeenAt: NOW - 2 * HOUR,
        views: 1,
        ip: "203.0.113.1",
        browser: "Chrome",
        os: "Windows",
        device: "desktop",
        country: "ES",
        language: "es-ES",
        screen: "1920x1080",
        referrerKind: "direct",
        referrerSource: null,
        campaign: null,
        medium: null,
        ...over
    };
}

function view(sessionId: string, path: string, at: number): VisitEventRow {
    return { sessionId, at, kind: "pageview", name: null, path };
}

describe("reportVisits", () => {
    it("counts views, sessions and visitors", () => {
        const sessions = [session("a"), session("b")];
        const events = [view("a", "/", NOW - 2 * HOUR), view("a", "/about", NOW - HOUR), view("b", "/", NOW - HOUR)];
        const { overview } = reportVisits({ sessions, events, from: FROM, to: NOW + 1 });
        expect(overview.views).toBe(3);
        expect(overview.sessions).toBe(2);
        expect(overview.visitors).toBe(2);
        expect(overview.viewsPerSession).toBe(1.5);
    });

    it("calls a one-page visit a bounce and a two-page visit not one", () => {
        const sessions = [session("a"), session("b")];
        const events = [view("a", "/", NOW - 2 * HOUR), view("a", "/about", NOW - HOUR), view("b", "/", NOW - HOUR)];
        const { overview } = reportVisits({ sessions, events, from: FROM, to: NOW + 1 });
        expect(overview.bounceRate).toBe(0.5);
    });

    it("averages only the visits whose length is known", () => {
        const sessions = [
            session("a", { startedAt: NOW - 2 * HOUR, lastSeenAt: NOW - 2 * HOUR + 60_000 }),
            // Never came back: a single beat, so there is no duration to average in.
            session("b", { startedAt: NOW - HOUR, lastSeenAt: NOW - HOUR })
        ];
        const events = [view("a", "/", NOW - 2 * HOUR), view("b", "/", NOW - HOUR)];
        const { overview } = reportVisits({ sessions, events, from: FROM, to: NOW + 1 });
        expect(overview.avgVisitSec).toBe(60);
    });

    it("says null rather than zero when nothing was measured", () => {
        const { overview } = reportVisits({ sessions: [], events: [], from: FROM, to: NOW + 1 });
        expect(overview.bounceRate).toBeNull();
        expect(overview.avgVisitSec).toBeNull();
        expect(overview.viewsPerSession).toBeNull();
    });

    it("ignores what falls outside the window", () => {
        const sessions = [session("old", { startedAt: FROM - 5 * HOUR, lastSeenAt: FROM - 5 * HOUR })];
        const events = [view("old", "/", FROM - 5 * HOUR)];
        const { overview } = reportVisits({ sessions, events, from: FROM, to: NOW });
        expect(overview.views).toBe(0);
        expect(overview.sessions).toBe(0);
    });

    it("keeps a visit that began before the window but is still going", () => {
        const sessions = [session("a", { startedAt: FROM - HOUR, lastSeenAt: NOW - HOUR })];
        const events = [view("a", "/", NOW - HOUR)];
        const { overview } = reportVisits({ sessions, events, from: FROM, to: NOW });
        expect(overview.sessions).toBe(1);
        expect(overview.views).toBe(1);
    });

    it("ranks top pages by visitors, not by one visitor's reloads", () => {
        const sessions = [session("a"), session("b"), session("c")];
        const events = [
            ...Array.from({ length: 20 }, (_, i) => view("a", "/reloaded", NOW - HOUR + i)),
            view("b", "/popular", NOW - HOUR),
            view("c", "/popular", NOW - HOUR)
        ];
        const { breakdowns } = reportVisits({ sessions, events, from: FROM, to: NOW + 1 });
        expect(breakdowns.path[0]).toEqual({ key: "/popular", visitors: 2, views: 2 });
        expect(breakdowns.path[1]).toEqual({ key: "/reloaded", visitors: 1, views: 20 });
    });

    it("reads the entry and exit page off the order of the visit", () => {
        const sessions = [session("a")];
        const events = [
            view("a", "/landing", NOW - 3 * HOUR),
            view("a", "/middle", NOW - 2 * HOUR),
            view("a", "/checkout", NOW - HOUR)
        ];
        const { breakdowns } = reportVisits({ sessions, events, from: FROM, to: NOW + 1 });
        expect(breakdowns.entry.map((row) => row.key)).toEqual(["/landing"]);
        expect(breakdowns.exit.map((row) => row.key)).toEqual(["/checkout"]);
    });

    it("gives direct traffic a row instead of dropping it", () => {
        const sessions = [session("a"), session("b", { referrerKind: "search", referrerSource: "Google" })];
        const events = [view("a", "/", NOW - HOUR), view("b", "/", NOW - HOUR)];
        const { breakdowns } = reportVisits({ sessions, events, from: FROM, to: NOW + 1 });
        expect(breakdowns.referrer.map((row) => row.key).sort()).toEqual(["Direct", "Google"]);
    });

    it("breaks down the session's own dimensions", () => {
        const sessions = [
            session("a", { browser: "Safari", os: "iOS", device: "mobile", country: "PT", ip: "198.51.100.4" }),
            session("b")
        ];
        const events = [view("a", "/", NOW - HOUR), view("b", "/", NOW - HOUR)];
        const { breakdowns } = reportVisits({ sessions, events, from: FROM, to: NOW + 1 });
        expect(breakdowns.browser.map((row) => row.key).sort()).toEqual(["Chrome", "Safari"]);
        expect(breakdowns.device.map((row) => row.key).sort()).toEqual(["desktop", "mobile"]);
        expect(breakdowns.country.map((row) => row.key).sort()).toEqual(["ES", "PT"]);
        expect(breakdowns.ip.map((row) => row.key).sort()).toEqual(["198.51.100.4", "203.0.113.1"]);
    });

    it("counts a custom event apart from a pageview", () => {
        const sessions = [session("a")];
        const events: VisitEventRow[] = [
            view("a", "/pricing", NOW - HOUR),
            { sessionId: "a", at: NOW - HOUR + 1000, kind: "event", name: "signup", path: "/pricing" }
        ];
        const { overview, breakdowns } = reportVisits({ sessions, events, from: FROM, to: NOW + 1 });
        expect(overview.views).toBe(1);
        expect(overview.events).toBe(1);
        expect(breakdowns.event).toEqual([{ key: "signup", visitors: 1, views: 1 }]);
    });

    it("counts a visitor in every bucket they were active in", () => {
        const sessions = [session("a", { startedAt: NOW - 3 * HOUR, lastSeenAt: NOW - HOUR })];
        const events = [view("a", "/", NOW - 3 * HOUR), view("a", "/b", NOW - HOUR)];
        const { series } = reportVisits({ sessions, events, from: NOW - 4 * HOUR, to: NOW, buckets: 4 });
        expect(series).toHaveLength(4);
        expect(series.filter((point) => point.visitors > 0)).toHaveLength(2);
        expect(series.reduce((sum, point) => sum + point.views, 0)).toBe(2);
    });

    it("caps a breakdown at the limit asked for", () => {
        const sessions = Array.from({ length: 30 }, (_, i) => session(`s${i}`));
        const events = sessions.map((s, i) => view(s.id, `/page-${i}`, NOW - HOUR));
        const { breakdowns } = reportVisits({ sessions, events, from: FROM, to: NOW + 1, limit: 5 });
        expect(breakdowns.path).toHaveLength(5);
    });
});

describe("visitSessionId", () => {
    it("is stable for the same visitor on the same day", async () => {
        const args = { salt: "day-salt", siteId: "site", ip: "203.0.113.1", userAgent: "Chrome" };
        expect(await visitSessionId(args)).toBe(await visitSessionId(args));
    });

    it("changes when the salt rotates, so nobody is followed between days", async () => {
        const base = { siteId: "site", ip: "203.0.113.1", userAgent: "Chrome" };
        expect(await visitSessionId({ ...base, salt: "monday" })).not.toBe(
            await visitSessionId({ ...base, salt: "tuesday" })
        );
    });

    it("separates two visitors and two sites", async () => {
        const base = { salt: "s", siteId: "site", ip: "203.0.113.1", userAgent: "Chrome" };
        expect(await visitSessionId(base)).not.toBe(await visitSessionId({ ...base, ip: "203.0.113.2" }));
        expect(await visitSessionId(base)).not.toBe(await visitSessionId({ ...base, siteId: "other" }));
    });
});

describe("visitDay", () => {
    it("floors to UTC midnight", () => {
        expect(visitDay(Date.UTC(2026, 7, 3, 23, 59, 59))).toBe(Date.UTC(2026, 7, 3));
        expect(visitDay(Date.UTC(2026, 7, 4, 0, 0, 0))).toBe(Date.UTC(2026, 7, 4));
    });
});

describe("analytics geo", () => {
    it("reads the country off a time zone", () => {
        expect(countryForTimeZone("Europe/Madrid")).toBe("ES");
        expect(countryForTimeZone("America/Sao_Paulo")).toBe("BR");
        expect(countryForTimeZone("Asia/Tokyo")).toBe("JP");
    });

    it("says nothing rather than guessing for a zone it does not know", () => {
        expect(countryForTimeZone("Mars/Olympus")).toBeNull();
        expect(countryForTimeZone(null)).toBeNull();
        // A zone shared by several countries is deliberately absent.
        expect(countryForTimeZone("UTC")).toBeNull();
    });

    it("prefers the edge's header and ignores its non-answers", () => {
        expect(resolveCountry("PT", "Europe/Madrid")).toBe("PT");
        expect(resolveCountry("XX", "Europe/Madrid")).toBe("ES");
        expect(resolveCountry("T1", "Europe/Madrid")).toBe("ES");
        expect(resolveCountry(null, "Europe/Madrid")).toBe("ES");
        expect(resolveCountry(null, null)).toBeNull();
    });

    it("names and flags a country without a table of either", () => {
        expect(countryName("ES")).toBe("Spain");
        expect(countryName("jp")).toBe("Japan");
        expect(countryName(null)).toBe("Unknown");
        expect(countryFlag("ES")).toBe("\u{1F1EA}\u{1F1F8}");
        expect(countryFlag("")).toBe("");
    });

    it("takes the first language off the header", () => {
        expect(parseLanguage("es-ES,es;q=0.9,en;q=0.8")).toBe("es-ES");
        expect(parseLanguage("en")).toBe("en");
        expect(parseLanguage("*")).toBeNull();
        expect(parseLanguage(null)).toBeNull();
        expect(parseLanguage("not a language!")).toBeNull();
    });
});
