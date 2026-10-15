/**
 * The compare and insights routes: both ask for the Servers permission before
 * anything else, refuse a malformed query with a 400 before reading a row, and
 * answer a server that is not the reader's with a 404 for the whole request
 * rather than a silent gap.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "owner-1";
const MINE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const THEIRS = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const LOCAL_SUBJECT = "00000000-0000-4000-8000-000000000001";

let allowed = true;
const asked: string[] = [];
const seriesRead: { subjectId: string; ownerId: string; from: Date; to: Date }[] = [];
const insightsRead: string[][] = [];

vi.mock("@/lib/api-session", () => ({
    apiPermission: async (permission: string) => {
        asked.push(permission);
        return allowed ? { id: OWNER } : Response.json({ error: "forbidden" }, { status: 403 });
    }
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/metrics-history-service", () => ({
    getMetricSeries: async (input: { subjectId: string; ownerId: string; from: Date; to: Date }) => {
        seriesRead.push(input);
        return input.subjectId === THEIRS ? null : [{ t: 1, cpuPercent: 5 }];
    },
    subjectBelongsToOwner: async (_type: string, subject: string, owner: string) =>
        subject !== THEIRS && owner === OWNER
}));
vi.mock("@/lib/server-insights/insights", () => ({
    readServerInsights: async (subjects: string[]) => {
        insightsRead.push(subjects);
        return subjects.map((subject) => ({
            subject,
            anomalies: [],
            forecast: { kind: "insufficient", spanDays: 0, usedBytes: null, totalBytes: null },
            diskWarning: false,
            historyHours: 0
        }));
    }
}));

const compare = await import("../../src/app/api/servers/compare/route");
const insights = await import("../../src/app/api/servers/insights/route");

function get(path: string): Request {
    return new Request(`http://polaris.test${path}`);
}

beforeEach(() => {
    allowed = true;
    asked.length = 0;
    seriesRead.length = 0;
    insightsRead.length = 0;
});

describe("GET /api/servers/compare", () => {
    it("asks for the Servers permission and stops there without it", async () => {
        allowed = false;
        const res = await compare.GET(get(`/api/servers/compare?ids=local,${MINE}`));
        expect(res.status).toBe(403);
        expect(asked).toEqual(["system.manage"]);
        expect(seriesRead).toHaveLength(0);
    });

    it.each([
        ["no ids", "/api/servers/compare"],
        ["an id that is neither local nor a uuid", "/api/servers/compare?ids=local,web-1"],
        ["more than four servers", `/api/servers/compare?ids=local,${MINE},${THEIRS},${MINE.slice(0, -1)}d,${MINE.slice(0, -1)}e`],
        ["a range that is not offered", `/api/servers/compare?ids=local,${MINE}&range=2y`]
    ])("refuses %s with a 400 before reading", async (_name, path) => {
        const res = await compare.GET(get(path));
        expect(res.status).toBe(400);
        expect(seriesRead).toHaveLength(0);
    });

    it("answers each server under the id it was asked by, over one window", async () => {
        const res = await compare.GET(get(`/api/servers/compare?ids=local,${MINE},local&range=7d`));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { from: number; to: number; servers: { id: string }[] };
        expect(body.servers.map((one) => one.id)).toEqual(["local", MINE]);
        expect(seriesRead.map((one) => one.subjectId)).toEqual([LOCAL_SUBJECT, MINE]);
        expect(seriesRead.every((one) => one.ownerId === OWNER)).toBe(true);
        expect(body.to - body.from).toBe(7 * 86_400_000);
    });

    it("is a 404 when any of the servers is not the reader's", async () => {
        const res = await compare.GET(get(`/api/servers/compare?ids=${MINE},${THEIRS}`));
        expect(res.status).toBe(404);
    });
});

describe("GET /api/servers/insights", () => {
    it("asks for the Servers permission and stops there without it", async () => {
        allowed = false;
        const res = await insights.GET(get("/api/servers/insights?ids=local"));
        expect(res.status).toBe(403);
        expect(asked).toEqual(["system.manage"]);
        expect(insightsRead).toHaveLength(0);
    });

    it("refuses a malformed list with a 400", async () => {
        for (const path of ["/api/servers/insights", "/api/servers/insights?ids=,,", "/api/servers/insights?ids=../etc"]) {
            const res = await insights.GET(get(path));
            expect(res.status).toBe(400);
        }
        expect(insightsRead).toHaveLength(0);
    });

    it("is a 404 for the whole request when one server is not the reader's", async () => {
        const res = await insights.GET(get(`/api/servers/insights?ids=local,${THEIRS}`));
        expect(res.status).toBe(404);
        expect(insightsRead).toHaveLength(0);
    });

    it("reads the metric subjects and answers by the ids the reader used", async () => {
        const res = await insights.GET(get(`/api/servers/insights?ids=local,${MINE}`));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { servers: { id: string; subject: string }[] };
        expect(insightsRead).toEqual([[LOCAL_SUBJECT, MINE]]);
        expect(body.servers.map((one) => one.id)).toEqual(["local", MINE]);
    });
});
