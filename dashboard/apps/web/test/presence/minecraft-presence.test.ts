/**
 * Somebody on a Minecraft server here is around, with or without a Polaris tab.
 *
 * Their sessions say offline, so the server is what speaks for them: idle, with
 * the server's card. Everything they could have said instead still wins - a
 * chosen invisible, a hidden last-seen, the activity audience or the Minecraft
 * switch in Privacy - because each of those keeps them offline.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-10-12T20:00:00Z");

type Person = {
    id: string;
    presence: string;
    presenceUntil: Date | null;
    presenceSetAt: Date | null;
    displayPrefs: string | null;
    deviceTimeZone: string | null;
    statusText: string;
    statusUntil: Date | null;
};

let people: Person[];
let lastSeen: Map<string, Date>;
let lastSeenHidden: Set<string>;
/** What activitiesFor answers - it owns the activity audience and the switches. */
let doing: Map<string, { source: string; name: string }[]>;
let askedAbout: string[];

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findMany: async () => people },
        sessionState: {
            groupBy: async () =>
                [...lastSeen].map(([userId, lastSeenAt]) => ({ userId, _max: { lastSeenAt } }))
        },
        meetingParticipant: { findMany: async () => [] }
    }
}));
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (_viewer: unknown, _field: string, ids: readonly string[]) =>
        new Set(ids.filter((id) => !lastSeenHidden.has(id)))
}));
vi.mock("@/lib/presence-activity/service", () => ({
    activitiesFor: async (_viewer: unknown, ids: readonly string[]) => {
        askedAbout = [...ids];
        return new Map([...doing].filter(([id]) => ids.includes(id)));
    }
}));
vi.mock("@/lib/chat/access", () => ({ reachableChannelIds: async () => new Set<string>() }));
vi.mock("@/lib/chat/meetings", () => ({ PARTICIPANT_TTL_MS: 60_000 }));
vi.mock("@/lib/presence-schedule-service", () => ({
    activeSchedulesFor: async () => new Map(),
    schedulesOf: async () => [],
    scheduleZoneOf: async () => "auto"
}));
vi.mock("@/lib/display-prefs-service", () => ({ getPlatformDisplayPreferences: async () => ({}) }));

const viewer = { id: "grace", isAdmin: false };
const minecraft = { source: "minecraft", name: "Minecraft" };

function person(id: string, presence = "auto"): Person {
    return {
        id,
        presence,
        presenceUntil: null,
        presenceSetAt: null,
        displayPrefs: null,
        deviceTimeZone: null,
        statusText: "",
        statusUntil: null
    };
}

beforeEach(() => {
    vi.setSystemTime(NOW);
    people = [person("ada")];
    // Last here two hours ago: offline by every session they have.
    lastSeen = new Map([["ada", new Date(NOW.getTime() - 2 * 3_600_000)]]);
    lastSeenHidden = new Set();
    doing = new Map();
    askedAbout = [];
});

async function statusOf(id: string) {
    const { presenceFor } = await import("@/lib/presence-service");
    return (await presenceFor(viewer, [id])).get(id);
}

describe("somebody playing on a server here", () => {
    it("is idle and playing, with no Polaris open", async () => {
        doing.set("ada", [minecraft]);
        const found = await statusOf("ada");
        expect(found?.status).toBe("idle");
        expect(found?.activity).toEqual([minecraft]);
    });

    it("shows only the server, not what a computer nobody watches reported", async () => {
        doing.set("ada", [minecraft, { source: "spotify", name: "A song" }]);
        expect((await statusOf("ada"))?.activity).toEqual([minecraft]);
    });

    it("carries the line they set", async () => {
        people[0].statusText = " back at dusk ";
        doing.set("ada", [minecraft]);
        expect((await statusOf("ada"))?.note).toBe("back at dusk");
    });

    it("stays online when they also have Polaris open", async () => {
        lastSeen.set("ada", new Date(NOW.getTime() - 30_000));
        doing.set("ada", [minecraft]);
        expect((await statusOf("ada"))?.status).toBe("online");
    });
});

describe("Privacy still decides", () => {
    it("keeps them offline when activity or the Minecraft switch is hidden", async () => {
        // activitiesFor answers nothing for them, which is what both settings do.
        expect((await statusOf("ada"))?.status).toBe("offline");
    });

    it("keeps them offline when they chose invisible", async () => {
        people = [person("ada", "invisible")];
        doing.set("ada", [minecraft]);
        expect(await statusOf("ada")).toMatchObject({ status: "offline", activity: [] });
        expect(askedAbout).not.toContain("ada");
    });

    it("keeps them offline, unasked, when last seen is hidden from this reader", async () => {
        lastSeenHidden.add("ada");
        doing.set("ada", [minecraft]);
        expect(await statusOf("ada")).toMatchObject({ status: "offline", activity: [] });
        expect(askedAbout).not.toContain("ada");
    });

    it("does not lift a status they chose", async () => {
        people = [person("ada", "busy")];
        doing.set("ada", [minecraft]);
        expect((await statusOf("ada"))?.status).toBe("busy");
    });
});
