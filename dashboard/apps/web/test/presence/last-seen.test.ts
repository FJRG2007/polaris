/**
 * "Last seen": the time somebody drawn as offline was last here.
 *
 * Only for somebody offline by their sessions - never for an "appear offline"
 * they chose, never for somebody whose presence is hidden from the reader, and
 * only where the reciprocal `lastActive` check lets it through. Asked once for
 * the whole page, not once per face.
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
let timeHidden: Set<string>;
let asked: { field: string; ids: string[] }[];

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
        new Set(ids.filter((id) => !lastSeenHidden.has(id))),
    reciprocalAmong: async (_viewer: unknown, field: string, ids: readonly string[]) => {
        asked.push({ field, ids: [...ids] });
        return new Set(ids.filter((id) => !timeHidden.has(id)));
    }
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
    timeHidden = new Set();
    asked = [];
});

async function statusOf(id: string) {
    const { presenceFor } = await import("@/lib/presence-service");
    return (await presenceFor(viewer, [id])).get(id);
}

describe("last seen", () => {
    it("tells the time for somebody offline by their sessions", async () => {
        expect((await statusOf("ada"))?.lastActive).toBe(lastSeen.get("ada")!.toISOString());
        expect(asked).toEqual([{ field: "lastActive", ids: ["ada"] }]);
    });

    it("says nothing for somebody who chose to appear offline", async () => {
        people = [person("ada", "invisible")];
        expect((await statusOf("ada"))?.lastActive).toBeNull();
        expect(asked).toEqual([]);
    });

    it("says nothing when their presence is hidden from the reader", async () => {
        lastSeenHidden.add("ada");
        expect((await statusOf("ada"))?.lastActive).toBeNull();
    });

    it("says nothing when the reciprocal setting keeps it between them", async () => {
        timeHidden.add("ada");
        expect((await statusOf("ada"))?.lastActive).toBeNull();
    });

    it("says nothing for somebody who is here", async () => {
        lastSeen.set("ada", new Date(NOW.getTime() - 30_000));
        expect((await statusOf("ada"))?.lastActive).toBeNull();
    });

    it("asks about a whole page in one call", async () => {
        people = [person("ada"), person("bob"), person("cy")];
        lastSeen.set("bob", new Date(NOW.getTime() - 3_600_000));
        lastSeen.set("cy", new Date(NOW.getTime() - 3_600_000));
        const { presenceFor } = await import("@/lib/presence-service");
        await presenceFor(viewer, ["ada", "bob", "cy"]);
        expect(asked).toHaveLength(1);
        expect(asked[0]!.ids.sort()).toEqual(["ada", "bob", "cy"]);
    });
});
