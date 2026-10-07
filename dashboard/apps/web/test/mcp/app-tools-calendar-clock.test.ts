/**
 * Calendar's alarm and timer tools, called the way an MCP client calls them.
 *
 * The Time area's service is tested on its own (test/calendar); what is pinned
 * here is the boundary: an alarm is set in the person's own zone with the days
 * a model writes turned into the stored bits, an alarm or timer is found by its
 * label or time but never guessed between two of one name, reading does not
 * open changing, and a timer's length is the sum of what was asked for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    actingUser: vi.fn(),
    readerView: vi.fn(),
    clockSnapshot: vi.fn(),
    saveAlarm: vi.fn(),
    setAlarmEnabled: vi.fn(),
    skipAlarm: vi.fn(),
    snoozeAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
    createTimer: vi.fn(),
    changeTimer: vi.fn(),
    deleteTimer: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: mocks.actingUser }));
vi.mock("@/lib/i18n/request", () => ({ getLocale: async () => "en-US" }));
vi.mock("@polaris-app/calendar/src/lib/upcoming", () => ({
    readerView: mocks.readerView,
    upcomingEvents: vi.fn()
}));
vi.mock("@polaris-app/calendar/src/lib/clock/service", () => ({
    clockSnapshot: mocks.clockSnapshot,
    saveAlarm: mocks.saveAlarm,
    setAlarmEnabled: mocks.setAlarmEnabled,
    skipAlarm: mocks.skipAlarm,
    snoozeAlarm: mocks.snoozeAlarm,
    deleteAlarm: mocks.deleteAlarm,
    createTimer: mocks.createTimer,
    changeTimer: mocks.changeTimer,
    deleteTimer: mocks.deleteTimer
}));

const { calendarExtension } = await import("@polaris-app/calendar/src/lib/calendar-extension");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");
const { daysToBits, bitsToDays } = await import("@polaris-app/calendar/src/lib/mcp-clock-tools");

const TOOLS = [...(await calendarExtension.mcpTools!())];
const SERVER = { name: "polaris", version: "1", instructions: "" };
const ADA = { id: "user-1", email: "ada@example.test", name: "Ada", isAdmin: false, sessionId: "" };
const GYM = "33333333-3333-4333-8333-333333333333";
const WORK = "44444444-4444-4444-8444-444444444444";
const TEA = "55555555-5555-4555-8555-555555555555";

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

async function call(name: string, args: Record<string, unknown>, scopes = ["calendar.manage"]) {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, grantId: "grant-1" },
        SERVER
    );
    return (reply?.result ?? reply?.error) as ToolResult & { message?: string };
}

function alarm(id: string, time: string, label: string, days = 0) {
    return {
        id,
        time,
        days,
        label,
        sound: "chime",
        snoozeMinutes: 10,
        enabled: true,
        zone: "Europe/Madrid",
        nextFireAt: "2026-10-08T05:30:00.000Z",
        snoozed: false
    };
}

const tea = {
    id: TEA,
    label: "Tea",
    durationMs: 240_000,
    sound: "chime",
    endsAt: null,
    remainingMs: 120_000,
    firedAt: null,
    pomodoro: null
};

function snapshot(alarms = [alarm(GYM, "07:30", "Gym"), alarm(WORK, "08:00", "Work")]) {
    return {
        alarms,
        timers: [tea],
        stopwatch: { startedAt: null, elapsedMs: 0, laps: [] },
        serverNow: "2026-10-07T18:00:00.000Z"
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.actingUser.mockResolvedValue(ADA);
    mocks.readerView.mockResolvedValue({
        user: ADA,
        zone: "Europe/Madrid",
        shown: [],
        preferences: { defaultAlarms: { timed: [], allDay: [] } }
    });
    mocks.clockSnapshot.mockResolvedValue(snapshot());
    mocks.createTimer.mockResolvedValue(TEA);
});

describe("days as a model writes them", () => {
    it("turn into the stored bits and back", () => {
        expect(daysToBits([])).toBe(0);
        expect(daysToBits(["weekdays"])).toBe(0b0111110);
        expect(daysToBits(["sat", "sun"])).toBe(0b1000001);
        expect(daysToBits(["mon", "wed"])).toBe(0b0001010);
        expect(bitsToDays(0)).toBe("once");
        expect(bitsToDays(0b1000001)).toBe("weekend");
        expect(bitsToDays(0b0001010)).toBe("mon, wed");
    });
});

describe("the alarm tools", () => {
    it("set a new alarm in the person's own zone, on the days asked for", async () => {
        const result = await call("clock_alarm_set", {
            time: "06:45",
            days: ["weekdays"],
            label: "Run"
        });
        expect(result.isError).toBeUndefined();
        expect(mocks.saveAlarm).toHaveBeenCalledWith(
            "user-1",
            null,
            {
                time: "06:45",
                days: 0b0111110,
                label: "Run",
                sound: "chime",
                snoozeMinutes: 10,
                enabled: true
            },
            "Europe/Madrid"
        );
    });

    it("change an alarm found by its label, keeping what was not given", async () => {
        await call("clock_alarm_set", { alarm: "gym", time: "07:00" });
        expect(mocks.saveAlarm).toHaveBeenCalledWith(
            "user-1",
            GYM,
            expect.objectContaining({ time: "07:00", label: "Gym", days: 0 }),
            "Europe/Madrid"
        );
    });

    it("find an alarm by its time, and act on it", async () => {
        const result = await call("clock_alarm_change", { alarm: "08:00", action: "snooze" });
        expect(result.content[0]?.text).toBe('Snoozed: "Work" (08:00).');
        expect(mocks.snoozeAlarm).toHaveBeenCalledWith("user-1", WORK);
    });

    it("never guess between two alarms of one name, and offer the closest for a miss", async () => {
        mocks.clockSnapshot.mockResolvedValue(
            snapshot([alarm(GYM, "07:30", "Gym"), alarm(WORK, "18:00", "Gym")])
        );
        const twice = await call("clock_alarm_change", { alarm: "Gym", action: "delete" });
        expect(twice.isError).toBe(true);
        expect(twice.content[0]?.text).toContain("More than one alarm");
        expect(twice.content[0]?.text).toContain(GYM);
        const missed = await call("clock_alarm_change", { alarm: "Gim", action: "off" });
        expect(missed.content[0]?.text).toContain('No alarm is called "Gim"');
        expect(mocks.deleteAlarm).not.toHaveBeenCalled();
        expect(mocks.setAlarmEnabled).not.toHaveBeenCalled();
    });

    it("refuse a new alarm without a time, and every change to a reading connection", async () => {
        const untimed = await call("clock_alarm_set", { label: "Nap" });
        expect(untimed.content[0]?.text).toContain("HH:mm");
        const reading = await call("clock_alarm_set", { time: "07:00" }, ["calendar.read"]);
        expect(reading.content[0]?.text).toContain("calendar.manage");
        expect(mocks.saveAlarm).not.toHaveBeenCalled();
    });

    it("list alarms and timers to a reading connection", async () => {
        const result = await call("clock_list", {}, ["calendar.read"]);
        expect(result.structuredContent.alarms.map((row: any) => row.label)).toEqual([
            "Gym",
            "Work"
        ]);
        expect(result.structuredContent.timers[0]).toMatchObject({
            label: "Tea",
            state: "paused",
            left: "02:00"
        });
    });
});

describe("the timer tools", () => {
    it("start a timer for the sum of what was asked", async () => {
        const result = await call("clock_timer_start", { minutes: 1, seconds: 30, label: "Eggs" });
        expect(result.content[0]?.text).toBe('Started a 01:30 timer "Eggs".');
        expect(mocks.createTimer).toHaveBeenCalledWith("user-1", {
            label: "Eggs",
            durationMs: 90_000,
            sound: "chime",
            start: true
        });
    });

    it("refuse a timer of no length", async () => {
        const result = await call("clock_timer_start", {});
        expect(result.isError).toBe(true);
        expect(mocks.createTimer).not.toHaveBeenCalled();
    });

    it("resume a timer found by its label", async () => {
        await call("clock_timer_change", { timer: "tea", action: "resume" });
        expect(mocks.changeTimer).toHaveBeenCalledWith("user-1", TEA, "start");
    });
});
