/**
 * A ring answered on one screen falls quiet on every other: stopping, snoozing
 * or deleting it is written on the row, and a ringing tab or device reads that
 * as "stop" - but never the scheduler moving the ring on, which happens whether
 * anybody heard it or not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser } from "../fixtures/fake-host";
import * as model from "@polaris-app/calendar/src/lib/clock/model";
import * as clock from "@polaris-app/calendar/src/lib/clock/service";
import { answered, ringsOf, type Ring } from "@polaris-app/calendar/src/screens/clock/ringer";

const ZONE = "Europe/Madrid";
const at = (iso: string) => new Date(iso);
const alarm = (): model.AlarmInput => ({
    time: "07:00",
    days: model.EVERY_DAY,
    label: "",
    sound: "chime",
    snoozeMinutes: 10,
    enabled: true
});

describe("a ring answered somewhere stops everywhere", () => {
    let alice: ReturnType<typeof addUser>;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
    });

    /** The ring a screen started sounding, from the snapshot it had then. */
    async function ringing(kind: "alarm" | "timer"): Promise<Ring> {
        const ring = ringsOf(await clock.clockSnapshot(alice.id)).find(
            (entry) => entry.kind === kind
        );
        expect(ring).toBeDefined();
        return ring!;
    }

    it("keeps an alarm ringing after the scheduler moves it on", async () => {
        await clock.saveAlarm(alice.id, null, alarm(), ZONE, world.NOW);
        const ring = await ringing("alarm");
        await clock.fireDueClocks(at("2026-10-02T05:00:05Z"));
        expect(answered(ring, await clock.clockSnapshot(alice.id))).toBe(false);
    });

    it("stops an alarm stopped on another device, even after the scheduler moved it", async () => {
        await clock.saveAlarm(alice.id, null, alarm(), ZONE, world.NOW);
        const ring = await ringing("alarm");
        await clock.fireDueClocks(at("2026-10-02T05:00:05Z"));
        await clock.dismissAlarm(alice.id, ring.id, new Date(ring.due), at("2026-10-02T05:00:09Z"));
        expect(answered(ring, await clock.clockSnapshot(alice.id))).toBe(true);
    });

    it("stops an alarm snoozed on another device", async () => {
        await clock.saveAlarm(alice.id, null, alarm(), ZONE, world.NOW);
        const ring = await ringing("alarm");
        await clock.snoozeAlarm(alice.id, ring.id, at("2026-10-02T05:00:04Z"), new Date(ring.due));
        const after = await clock.clockSnapshot(alice.id);
        expect(answered(ring, after)).toBe(true);
        // The snooze itself rings later, as a ring of its own.
        const snoozed = ringsOf(after).find((entry) => entry.id === ring.id)!;
        expect(snoozed.key).not.toBe(ring.key);
        expect(answered(snoozed, after)).toBe(false);
    });

    it("stops an alarm deleted on another device", async () => {
        await clock.saveAlarm(alice.id, null, alarm(), ZONE, world.NOW);
        const ring = await ringing("alarm");
        await clock.deleteAlarm(alice.id, ring.id);
        expect(answered(ring, await clock.clockSnapshot(alice.id))).toBe(true);
    });

    it("stops a timer dismissed on another device, before or after the scheduler rang it", async () => {
        await clock.createTimer(
            alice.id,
            { label: "Tea", durationMs: 4 * 60_000, sound: "bell", start: true },
            world.NOW
        );
        const ring = await ringing("timer");
        await clock.fireDueClocks(at("2026-10-01T08:04:03Z"));
        expect(answered(ring, await clock.clockSnapshot(alice.id))).toBe(false);
        await clock.dismissTimer(alice.id, ring.id, at("2026-10-01T08:04:06Z"), new Date(ring.due));
        expect(answered(ring, await clock.clockSnapshot(alice.id))).toBe(true);
    });

    it("stops a ringing timer reset from the timers list on another device", async () => {
        await clock.createTimer(
            alice.id,
            { label: "Tea", durationMs: 4 * 60_000, sound: "bell", start: true },
            world.NOW
        );
        const ring = await ringing("timer");
        // Due, not yet rung by the scheduler: still counting as far as the row says.
        await clock.changeTimer(alice.id, ring.id, "reset", at("2026-10-01T08:04:01Z"));
        expect(answered(ring, await clock.clockSnapshot(alice.id))).toBe(true);
    });

    it("answers an old dismiss without a due by the timer's own end, as before", async () => {
        await clock.createTimer(
            alice.id,
            { label: "Tea", durationMs: 4 * 60_000, sound: "bell", start: true },
            world.NOW
        );
        const ring = await ringing("timer");
        await clock.dismissTimer(alice.id, ring.id, at("2026-10-01T08:04:02Z"));
        expect(answered(ring, await clock.clockSnapshot(alice.id))).toBe(true);
        expect(db.rows("clockTimer")[0]!.endsAt).toBeNull();
    });
});
