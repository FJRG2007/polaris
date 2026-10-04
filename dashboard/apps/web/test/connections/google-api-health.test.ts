/**
 * The Google APIs check on the admin Integrations screen.
 *
 * Asked where the person who can switch an API on is looking: each API Polaris
 * calls, checked with a token some account here already granted for it, kept
 * for ten minutes, and linked straight to that API's page in the right project.
 * An API that comes back on releases every calendar that was waiting on it.
 */

import recorded from "../calendar/sync/fixtures/provider-errors.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();
const links: { id: string; userId: string; scope: string }[] = [];
const nudged: unknown[] = [];

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => void settings.set(key, value)
}));
vi.mock("@/lib/connections/store", () => ({
    readCredential: async (id: string) => ({ refreshToken: `refresh-${id}` })
}));
vi.mock("@/lib/google-calendar/service", () => ({
    getGoogleOAuthClient: async () => ({
        clientId: "100000000001-abc123.apps.googleusercontent.com",
        clientSecret: "secret"
    }),
    googleAccessToken: async (_client: unknown, refresh: string) => `access-for-${refresh}`
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        userConnection: {
            findFirst: async (args: { where: { userId?: string; scope: { contains: string } } }) =>
                links.find(
                    (link) =>
                        link.scope.includes(args.where.scope.contains) &&
                        (!args.where.userId || link.userId === args.where.userId)
                ) ?? null
        },
        calendarSource: {
            updateMany: async (args: unknown) => {
                nudged.push(args);
                return { count: 1 };
            }
        }
    }
}));

const { googleApiHealth } = await import("@/lib/connections/google-api-health");

const NOW = new Date("2026-10-03T10:00:00.000Z");
const calls: { url: string; auth: string }[] = [];
let answer: (url: string) => Response;

beforeEach(() => {
    settings.clear();
    links.length = 0;
    nudged.length = 0;
    calls.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, auth: init.headers.Authorization ?? "" });
        return answer(url);
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const disabled = () =>
    new Response(JSON.stringify(recorded.googleServiceDisabled.body), { status: 403 });

describe("googleApiHealth", () => {
    it("says an API is not checked yet while no account has granted it, linking the client's project", async () => {
        const apis = await googleApiHealth("admin-1");
        expect(calls).toEqual([]);
        expect(apis.map((api) => [api.id, api.state, api.url])).toEqual([
            [
                "calendar",
                "unknown",
                "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=100000000001"
            ],
            [
                "tasks",
                "unknown",
                "https://console.cloud.google.com/apis/library/tasks.googleapis.com?project=100000000001"
            ],
            [
                "drive",
                "unknown",
                "https://console.cloud.google.com/apis/library/drive.googleapis.com?project=100000000001"
            ]
        ]);
    });

    it("asks with the reader's own grant first and reads a switched-off API from Google's answer", async () => {
        links.push(
            {
                id: "other",
                userId: "member-1",
                scope: "openid https://www.googleapis.com/auth/calendar"
            },
            {
                id: "mine",
                userId: "admin-1",
                scope: "openid https://www.googleapis.com/auth/calendar"
            }
        );
        answer = () => disabled();
        const [calendar] = await googleApiHealth("admin-1");
        expect(calls).toEqual([
            {
                url: "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1&fields=kind",
                auth: "Bearer access-for-refresh-mine"
            }
        ]);
        expect(calendar).toMatchObject({
            state: "disabled",
            project: "100000000001",
            url: "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=100000000001"
        });
        expect(JSON.parse(settings.get("google-api.calendar")!)).toMatchObject({
            state: "disabled"
        });
    });

    it("keeps an answer for ten minutes, asks again on request, and releases waiting calendars once it is on", async () => {
        links.push({
            id: "mine",
            userId: "admin-1",
            scope: "https://www.googleapis.com/auth/calendar"
        });
        answer = () => disabled();
        await googleApiHealth("admin-1");
        answer = () =>
            new Response(JSON.stringify({ kind: "calendar#calendarList" }), { status: 200 });

        vi.setSystemTime(new Date(NOW.getTime() + 60_000));
        expect((await googleApiHealth("admin-1"))[0]?.state).toBe("disabled");
        expect(calls).toHaveLength(1);

        const [calendar] = await googleApiHealth("admin-1", true);
        expect(calls).toHaveLength(2);
        expect(calendar).toMatchObject({
            state: "enabled",
            url: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=100000000001"
        });
        expect(nudged).toEqual([
            expect.objectContaining({
                where: expect.objectContaining({ kind: "google", status: "setup" })
            })
        ]);
    });

    it("asks Google again for a forced check that arrives while an unforced one runs", async () => {
        links.push({
            id: "mine",
            userId: "admin-1",
            scope: "https://www.googleapis.com/auth/calendar"
        });
        answer = () => disabled();
        await googleApiHealth("admin-1");
        vi.setSystemTime(new Date(NOW.getTime() + 60_000));
        answer = () =>
            new Response(JSON.stringify({ kind: "calendar#calendarList" }), { status: 200 });
        const unforced = googleApiHealth("admin-1");
        const forced = googleApiHealth("admin-1", true);
        const again = googleApiHealth("admin-1");
        expect((await unforced)[0]?.state).toBe("disabled");
        expect((await forced)[0]?.state).toBe("enabled");
        expect(await again).toBe(await forced);
    });

    it("leaves the state alone when Google answers something else", async () => {
        links.push({
            id: "mine",
            userId: "admin-1",
            scope: "https://www.googleapis.com/auth/calendar"
        });
        answer = () => new Response(JSON.stringify(recorded.googleRateLimit.body), { status: 403 });
        const [calendar] = await googleApiHealth("admin-1");
        expect(calendar?.state).toBe("unknown");
        expect(settings.has("google-api.calendar")).toBe(false);
    });
});
