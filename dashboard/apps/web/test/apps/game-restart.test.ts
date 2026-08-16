import { describe, expect, it } from "vitest";
import {
    MAX_RESTART_DAYS,
    newPendingRestart,
    readPendingRestart,
    restartDue,
    type PendingRestart
} from "@/lib/apps/games-restart";

const NOW = new Date("2026-08-16T20:00:00.000Z");
const LATER = new Date("2026-08-16T23:00:00.000Z");

const booked = (overrides: Partial<PendingRestart> = {}): PendingRestart => ({
    when: "empty",
    at: null,
    reason: "a settings change",
    requestedAt: NOW.toISOString(),
    requestedBy: "user-1",
    ...overrides
});

describe("newPendingRestart", () => {
    it("takes one for when the server empties", () => {
        expect(newPendingRestart({ when: "empty", requestedBy: "user-1", now: NOW })).toMatchObject({
            when: "empty",
            at: null
        });
    });

    it("takes one for a moment in the future", () => {
        const made = newPendingRestart({
            when: "at",
            at: LATER.toISOString(),
            requestedBy: "user-1",
            now: NOW
        });
        expect(made?.at).toBe(LATER.toISOString());
    });

    it("refuses a time that has already passed rather than restarting at once", () => {
        // Somebody who typed yesterday meant tomorrow, and a server that went down
        // the instant they pressed save is what they were trying to avoid.
        expect(
            newPendingRestart({ when: "at", at: "2026-08-15T10:00:00.000Z", requestedBy: "u", now: NOW })
        ).toBeNull();
    });

    it("refuses a time that is not a time, and one absurdly far off", () => {
        expect(newPendingRestart({ when: "at", at: "soon", requestedBy: "u", now: NOW })).toBeNull();
        expect(newPendingRestart({ when: "at", requestedBy: "u", now: NOW })).toBeNull();
        const tooFar = new Date(NOW.getTime() + (MAX_RESTART_DAYS + 1) * 24 * 3600 * 1000).toISOString();
        expect(newPendingRestart({ when: "at", at: tooFar, requestedBy: "u", now: NOW })).toBeNull();
    });
});

describe("readPendingRestart", () => {
    it("reads back what was written", () => {
        expect(readPendingRestart({ pendingRestart: booked() })).toEqual(booked());
    });

    it("is null for a server with nothing booked", () => {
        expect(readPendingRestart({})).toBeNull();
        expect(readPendingRestart({ pendingRestart: null })).toBeNull();
    });

    it("refuses a half-written instruction rather than repairing one", () => {
        // A restart is disruptive; an instruction nobody can read is not one
        // anybody gave.
        expect(readPendingRestart({ pendingRestart: { when: "someday" } })).toBeNull();
        expect(readPendingRestart({ pendingRestart: { when: "at" } })).toBeNull();
        expect(readPendingRestart({ pendingRestart: { when: "at", at: "not a date" } })).toBeNull();
    });
});

describe("restartDue", () => {
    it("fires for an empty server, and not for one with somebody on it", () => {
        expect(restartDue(booked(), NOW, 0)).toBe(true);
        expect(restartDue(booked(), NOW, 1)).toBe(false);
    });

    it("does not treat a server that cannot be asked as empty", () => {
        // A server whose RCON hiccupped is one nothing is known about, and
        // restarting a full server on that basis is the worst outcome here.
        expect(restartDue(booked(), NOW, null)).toBe(false);
    });

    it("fires once the moment has arrived, whoever is playing", () => {
        const at = booked({ when: "at", at: LATER.toISOString() });
        expect(restartDue(at, NOW, 0)).toBe(false);
        expect(restartDue(at, LATER, 5)).toBe(true);
    });

    it("does nothing when nothing is booked", () => {
        expect(restartDue(null, NOW, 0)).toBe(false);
    });
});
