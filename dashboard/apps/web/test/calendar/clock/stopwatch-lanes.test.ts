/**
 * Several stopwatches at once: each is its owner's alone, "start all" gives
 * every lane the same start instant, "stop all" stops them against one moment,
 * readings come from timestamps rather than ticks, and the ranking orders them
 * the way a race finishes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, signIn } from "../fixtures/fake-host";
import * as actions from "@polaris-app/calendar/src/actions/clock";
import * as model from "@polaris-app/calendar/src/lib/clock/model";
import * as clock from "@polaris-app/calendar/src/lib/clock/service";
import { CalendarRefusal } from "@polaris-app/calendar/src/lib/errors";

const later = (ms: number) => new Date(world.NOW.getTime() + ms);

describe("named stopwatches", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
    });

    it("starts every stopped lane on one shared instant and stops them on one moment", async () => {
        const ids = [];
        for (const label of ["Ana", "Ben", "Cris"]) ids.push(await clock.addLane(alice.id, label));
        await clock.changeAllLanes(alice.id, "start", world.NOW);

        const started = db.rows("clockStopwatchLane").map((row) => (row.startedAt as Date).getTime());
        expect(new Set(started)).toEqual(new Set([world.NOW.getTime()]));

        // Ben finishes first, on his own; then everybody else stops together.
        await clock.changeLane(alice.id, ids[1]!, "pause", later(9_580));
        await clock.changeAllLanes(alice.id, "pause", later(12_000));

        const lanes = (await clock.clockSnapshot(alice.id, later(60_000))).lanes!;
        expect(lanes.map((lane) => [lane.label, lane.startedAt, lane.elapsedMs])).toEqual([
            ["Ana", null, 12_000],
            ["Ben", null, 9_580],
            ["Cris", null, 12_000]
        ]);
        expect(model.rankLanes(lanes, later(60_000).getTime()).map((lane) => lane.label)).toEqual(
            ["Ben", "Ana", "Cris"]
        );
    });

    it("resumes from the time already counted and keeps laps as running totals", async () => {
        const id = await clock.addLane(alice.id, "");
        await clock.changeLane(alice.id, id, "start", world.NOW);
        await clock.changeLane(alice.id, id, "lap", later(1_000));
        await clock.changeLane(alice.id, id, "pause", later(2_000));
        await clock.changeLane(alice.id, id, "start", later(10_000));
        await clock.changeLane(alice.id, id, "lap", later(11_500));

        const [lane] = (await clock.clockSnapshot(alice.id, later(12_000))).lanes!;
        expect(lane!.laps).toEqual([1_000, 3_500]);
        expect(model.stopwatchElapsed(lane!, later(12_000).getTime())).toBe(4_000);
    });

    it("lets nobody but the owner read or change a lane", async () => {
        const id = await clock.addLane(alice.id, "Mine");
        await expect(clock.changeLane(bob.id, id, "start")).rejects.toBeInstanceOf(
            CalendarRefusal
        );
        await expect(clock.renameLane(bob.id, id, "Theirs")).rejects.toBeInstanceOf(
            CalendarRefusal
        );
        await clock.changeLane(bob.id, id, "delete");
        await clock.changeAllLanes(bob.id, "start");

        expect((await clock.clockSnapshot(bob.id)).lanes).toEqual([]);
        const [row] = db.rows("clockStopwatchLane");
        expect(row!.label).toBe("Mine");
        expect(row!.startedAt).toBeNull();
    });

    it("keeps at most the limit", async () => {
        for (let index = 0; index < model.MAX_LANES; index++) await clock.addLane(alice.id, "");
        await expect(clock.addLane(alice.id, "")).rejects.toBeInstanceOf(CalendarRefusal);
    });

    it("validates what the screen sends and answers the whole snapshot", async () => {
        signIn(alice);
        expect((await actions.changeLaneAction({ change: "add", label: "x".repeat(500) })).ok).toBe(
            false
        );
        expect((await actions.changeLaneAction({ change: "all", to: "lap" })).ok).toBe(false);
        expect((await actions.changeLaneAction({ change: "start", id: "nope" })).ok).toBe(false);

        const added = await actions.changeLaneAction({ change: "add", label: "  Lane  " });
        expect(added.ok).toBe(true);
        if (!added.ok) return;
        const lane = added.snapshot.lanes![0]!;
        expect(lane.label).toBe("Lane");

        const renamed = await actions.changeLaneAction({
            change: "rename",
            id: lane.id,
            label: "Runner 1"
        });
        expect(renamed.ok && renamed.snapshot.lanes![0]!.label).toBe("Runner 1");
        const removed = await actions.changeLaneAction({ change: "delete", id: lane.id });
        expect(removed.ok && removed.snapshot.lanes).toEqual([]);
    });

    it("ranks stopped lanes by time, then running ones, then those never started", () => {
        const lane = (id: string, elapsedMs: number, startedAt: string | null = null) => ({
            id,
            label: id,
            elapsedMs,
            startedAt,
            laps: []
        });
        const now = Date.parse("2026-10-01T08:00:10.000Z");
        const ranked = model.rankLanes(
            [
                lane("idle", 0),
                lane("slow", 9_000),
                lane("running-near", 0, "2026-10-01T08:00:08.000Z"),
                lane("fast", 8_000),
                lane("running-far", 0, "2026-10-01T08:00:00.000Z")
            ],
            now
        );
        expect(ranked.map((entry) => entry.id)).toEqual([
            "fast",
            "slow",
            "running-far",
            "running-near",
            "idle"
        ]);
    });
});
