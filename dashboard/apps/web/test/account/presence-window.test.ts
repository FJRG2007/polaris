/**
 * A status that lasts an hour.
 *
 * The whole reason the window exists is the status people forget: "do not
 * disturb" put on for a meeting and still on two days later is worse than never
 * having set one, because everybody around them stops expecting an answer and
 * nobody is told. So the rule that matters is that a lapsed choice is not a
 * choice - it reads as `auto` to everybody, including to the picker that would
 * otherwise still show a tick beside it.
 *
 * Nothing runs on a schedule to make that true, which is deliberate: it is
 * worked out on the way past. That is exactly the kind of rule that quietly
 * stops holding, so it is asserted rather than commented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-08-16T12:00:00Z");

/** The one account every test reads. */
let person: {
    id: string;
    presence: string;
    presenceUntil: Date | null;
    presenceSetAt: Date | null;
    displayPrefs: string | null;
    statusText: string;
    statusUntil: Date | null;
};

/** When their newest session was last active. Fresh, so `auto` is "online" and
 *  a lapsed choice is visibly different from a held one. */
let lastSeenAt: Date;

/** What was written, so clearing an expired choice can be asserted rather than
 *  assumed from what came back. */
let written: { presence?: string; presenceUntil?: Date | null; presenceSetAt?: Date } | null;

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async () => [person],
            findUnique: async () => person,
            update: async ({ data }: { data: Record<string, unknown> }) => {
                written = data;
                return person;
            }
        },
        sessionState: {
            findMany: async () => [{ userId: person.id, lastSeenAt }]
        },
        meetingParticipant: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (_viewer: unknown, _field: string, userIds: readonly string[]) =>
        new Set(userIds)
}));
vi.mock("@/lib/chat/access", () => ({ reachableChannelIds: async () => new Set<string>() }));
vi.mock("@/lib/chat/meetings", () => ({ PARTICIPANT_TTL_MS: 60_000 }));
// Nobody here has written a schedule. That they beat a choice, and when, is
// asserted next door in status-schedule.test.ts.
vi.mock("@/lib/presence-schedule-service", () => ({
    activeSchedulesFor: async () => new Map(),
    schedulesOf: async () => [],
    scheduleZoneOf: async () => "auto"
}));
vi.mock("@/lib/display-prefs-service", () => ({ getPlatformDisplayPreferences: async () => ({}) }));

const viewer = { id: "grace", isAdmin: false };

beforeEach(() => {
    vi.setSystemTime(NOW);
    written = null;
    lastSeenAt = new Date(NOW.getTime() - 30_000);
    person = {
        id: "ada",
        presence: "busy",
        presenceUntil: null,
        presenceSetAt: null,
        displayPrefs: null,
        // The line beside the dot has its own test; here it is only what a row
        // actually carries, so nothing reads a column that is not there.
        statusText: "",
        statusUntil: null
    };
});

describe("a status with no window", () => {
    it("holds, which is what it always did", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        const found = await presenceFor(viewer, ["ada"]);
        expect(found.get("ada")?.status).toBe("busy");
    });
});

describe("a status with a window", () => {
    it("holds until the moment it names", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        person.presenceUntil = new Date(NOW.getTime() + 60_000);
        const found = await presenceFor(viewer, ["ada"]);
        expect(found.get("ada")?.status).toBe("busy");
    });

    it("is worked out again once that moment has passed", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        person.presenceUntil = new Date(NOW.getTime() - 1_000);
        const found = await presenceFor(viewer, ["ada"]);
        // Back to what the sessions say, which is somebody at their screen.
        expect(found.get("ada")?.status).toBe("online");
    });
});

describe("the picker that set it", () => {
    it("still shows a choice that is holding, and how long for", async () => {
        const { presenceChoiceOf } = await import("@/lib/presence-service");
        const until = new Date(NOW.getTime() + 3_600_000);
        person.presenceUntil = until;
        const mine = await presenceChoiceOf("ada");
        expect(mine.choice).toBe("busy");
        expect(mine.until).toBe(until.toISOString());
        expect(written).toBeNull();
    });

    it("clears one that has lapsed rather than leaving a tick on a lie", async () => {
        const { presenceChoiceOf } = await import("@/lib/presence-service");
        person.presenceUntil = new Date(NOW.getTime() - 1_000);
        const mine = await presenceChoiceOf("ada");
        expect(mine).toEqual({ choice: "auto", until: null, scheduled: false });
        expect(written).toEqual({ presence: "auto", presenceUntil: null });
    });
});

describe("choosing one", () => {
    it("works out the moment from the minutes it was given", async () => {
        const { setPresenceChoice } = await import("@/lib/presence-service");
        await setPresenceChoice("ada", "away", { minutes: 60 });
        expect(written?.presence).toBe("away");
        expect((written?.presenceUntil as Date).toISOString()).toBe(
            new Date(NOW.getTime() + 3_600_000).toISOString()
        );
    });

    it("keeps it until it is changed when no length was picked", async () => {
        const { setPresenceChoice } = await import("@/lib/presence-service");
        await setPresenceChoice("ada", "invisible", { minutes: null });
        expect(written).toEqual({ presence: "invisible", presenceUntil: null, presenceSetAt: NOW });
    });

    it("clears the window when the answer is to work it out again", async () => {
        // "Back to online, for an hour" is not a thing anybody means.
        const { setPresenceChoice } = await import("@/lib/presence-service");
        await setPresenceChoice("ada", "auto", { minutes: 60 });
        expect(written).toEqual({ presence: "auto", presenceUntil: null, presenceSetAt: NOW });
    });
});
