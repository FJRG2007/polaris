/**
 * A visit's country comes from its address through a database Polaris fetches for
 * itself: the right file is asked for, a missing month falls back to the last one,
 * a bad download never replaces a good copy, nothing is fetched twice at once, and
 * the visits recorded before the database arrived are placed once, in bounded steps.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const dataDir = mkdtempSync(join(tmpdir(), "polaris-geo-"));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DATA_DIR: dataDir }) }));

// A stand-in reader: a "database" is the text MMDB followed by ip=CC lines.
vi.mock("mmdb-lib", () => ({
    Reader: class {
        private readonly table: Map<string, string>;
        constructor(buffer: Buffer) {
            const text = buffer.toString("utf8");
            if (!text.startsWith("MMDB")) throw new Error("not a database");
            this.table = new Map(
                text
                    .split("\n")
                    .slice(1)
                    .filter(Boolean)
                    .map((line) => line.split("=") as [string, string])
            );
        }
        get(ip: string) {
            if (ip === "boom") throw new Error("unparseable");
            const code = this.table.get(ip);
            return code ? { country: { iso_code: code } } : null;
        }
    }
}));

const settings = new Map<string, string>();
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
    setSetting: vi.fn(async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    })
}));

const rollup = vi.fn(async () => ({ sites: 1 }));
vi.mock("@/lib/analytics-ingest", () => ({ rollupAnalyticsDay: (day: number) => rollup(day) }));

interface Row {
    id: string;
    ip: string | null;
    country: string | null;
    startedAt: Date;
    lastSeenAt: Date;
}
const sessions: Row[] = [];
vi.mock("@polaris/db", () => ({
    prisma: {
        analyticsSession: {
            findFirst: vi.fn(async () => {
                const sorted = [...sessions].sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime());
                return sorted[0] ? { lastSeenAt: sorted[0].lastSeenAt } : null;
            }),
            findMany: vi.fn(async ({ where, take }: { where: { lastSeenAt: { gte: Date; lt: Date }; id?: { gt: string } }; take: number }) =>
                sessions
                    .filter(
                        (row) =>
                            row.lastSeenAt >= where.lastSeenAt.gte &&
                            row.lastSeenAt < where.lastSeenAt.lt &&
                            row.country === null &&
                            row.ip !== null &&
                            (!where.id || row.id > where.id.gt)
                    )
                    .sort((a, b) => (a.id < b.id ? -1 : 1))
                    .slice(0, take)
                    .map((row) => ({ id: row.id, ip: row.ip, startedAt: row.startedAt }))
            ),
            updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: { country: string } }) => {
                let count = 0;
                for (const row of sessions) {
                    if (where.id.in.includes(row.id) && row.country === null) {
                        row.country = data.country;
                        count += 1;
                    }
                }
                return { count };
            })
        }
    }
}));

import * as geo from "@/lib/analytics-geoip";
import { backfillVisitCountries } from "@/lib/analytics-geo-backfill";

const DAY = 86_400_000;
const database = (lines: string[]) => gzipSync(Buffer.from(["MMDB", ...lines].join("\n")));
const fetchMock = vi.fn();

beforeEach(() => {
    // Every case starts from a server that has never fetched a copy.
    rmSync(join(dataDir, "geo"), { recursive: true, force: true });
    geo.resetGeoDatabaseForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    settings.clear();
    sessions.length = 0;
    rollup.mockClear();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("the geo database", () => {
    it("asks DB-IP for the month's country file", () => {
        expect(geo.downloadUrl(new Date(Date.UTC(2026, 10, 3)))).toBe(
            "https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz"
        );
        expect(geo.downloadUrl(new Date(Date.UTC(2027, 0, 1)))).toBe(
            "https://download.db-ip.com/free/dbip-country-lite-2027-01.mmdb.gz"
        );
    });

    it("places nobody before a copy has arrived, and starts fetching it", async () => {
        fetchMock.mockResolvedValue(new Response(database(["8.8.8.8=US"])));
        expect(geo.countryForIp("8.8.8.8")).toBeNull();
        await geo.ensureGeoDatabase();
        expect(geo.countryForIp("8.8.8.8")).toBe("US");
        expect(geo.countryForIp("10.0.0.1")).toBeNull();
        expect(geo.countryForIp("boom")).toBeNull();
        expect(geo.countryForIp(null)).toBeNull();
    });

    it("falls back to last month's file early in a month, and keeps it on disk", async () => {
        fetchMock
            .mockResolvedValueOnce(new Response("missing", { status: 404 }))
            .mockResolvedValueOnce(new Response(database(["1.1.1.1=AU"])));
        await geo.ensureGeoDatabase();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(geo.countryForIp("1.1.1.1")).toBe("AU");
        const file = join(dataDir, "geo", "dbip-country-lite.mmdb");
        expect(readFileSync(file, "utf8")).toContain("1.1.1.1=AU");
        // No temp file left beside it.
        expect(readdirSync(join(dataDir, "geo")).filter((name) => name.endsWith(".tmp"))).toEqual([]);

        // A restart reads the copy from disk instead of fetching again.
        geo.resetGeoDatabaseForTests();
        fetchMock.mockReset();
        await geo.ensureGeoDatabase();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(geo.countryForIp("1.1.1.1")).toBe("AU");
    });

    it("never swaps in something that is not a database, and waits before trying again", async () => {
        fetchMock.mockResolvedValue(new Response(database(["2.2.2.2=FR"])));
        await geo.ensureGeoDatabase();
        const file = join(dataDir, "geo", "dbip-country-lite.mmdb");
        const good = readFileSync(file, "utf8");

        // A month later the download is an error page: the good copy stays, on disk and in use.
        const later = Date.now() + 40 * DAY;
        vi.spyOn(Date, "now").mockReturnValue(later);
        writeFileSync(file, good);
        fetchMock.mockReset().mockResolvedValue(new Response(gzipSync(Buffer.from("<html>error</html>"))));
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await geo.ensureGeoDatabase();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(readFileSync(file, "utf8")).toBe(good);
        expect(geo.countryForIp("2.2.2.2")).toBe("FR");

        // And the next try waits an hour instead of hammering the server.
        await geo.ensureGeoDatabase();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        spy.mockRestore();
        vi.restoreAllMocks();
    });

    it("fetches once when many visits ask at the same time", async () => {
        let release: (value: Response) => void = () => undefined;
        fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
        geo.resetGeoDatabaseForTests();
        const waits = [geo.ensureGeoDatabase(), geo.ensureGeoDatabase(), geo.ensureGeoDatabase()];
        expect(waits[0]).toBe(waits[1]);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        release(new Response(database(["9.9.9.9=CH"])));
        await Promise.all(waits);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(geo.countryForIp("9.9.9.9")).toBe("CH");
    });
});

describe("placing the visits recorded before", () => {
    it("fills only empty countries, walks a week per pass, and folds finished days again", async () => {
        fetchMock.mockResolvedValue(new Response(database(["5.5.5.5=ES", "6.6.6.6=FR"])));
        const now = Date.UTC(2026, 10, 20, 12);
        const today = Date.UTC(2026, 10, 20);
        for (let day = 0; day < 10; day += 1) {
            const at = new Date(today - day * DAY + 3_600_000);
            sessions.push({ id: `s-${day}-a`, ip: "5.5.5.5", country: null, startedAt: at, lastSeenAt: at });
            sessions.push({ id: `s-${day}-b`, ip: "6.6.6.6", country: "DE", startedAt: at, lastSeenAt: at });
            sessions.push({ id: `s-${day}-c`, ip: null, country: null, startedAt: at, lastSeenAt: at });
        }

        const first = await backfillVisitCountries(now);
        expect(first.done).toBe(false);
        expect(first.placed).toBe(7);

        const second = await backfillVisitCountries(now);
        expect(second.done).toBe(true);
        expect(second.placed).toBe(3);

        expect(sessions.filter((row) => row.ip === "5.5.5.5").every((row) => row.country === "ES")).toBe(true);
        // What was already known is never overwritten, and no address means no country.
        expect(sessions.filter((row) => row.id.endsWith("-b")).every((row) => row.country === "DE")).toBe(true);
        expect(sessions.filter((row) => row.ip === null).every((row) => row.country === null)).toBe(true);

        const folded = rollup.mock.calls.map(([day]) => day as number);
        expect(folded).not.toContain(today);
        expect(new Set(folded).size).toBe(9);

        // Done means done: no more reads.
        const third = await backfillVisitCountries(now);
        expect(third).toEqual({ placed: 0, done: true });
    });

    it("waits for the database instead of guessing", async () => {
        fetchMock.mockRejectedValue(new Error("offline"));
        sessions.push({ id: "x", ip: "5.5.5.5", country: null, startedAt: new Date(), lastSeenAt: new Date() });
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await backfillVisitCountries()).toEqual({ placed: 0, done: false });
        expect(settings.has("analytics.geoBackfill")).toBe(false);
        expect(sessions[0]!.country).toBeNull();
        spy.mockRestore();
    });
});
