import { describe, expect, it } from "vitest";
import {
    decide,
    INITIAL_STATE,
    readState,
    type DecideInput,
    type FlipState,
    type Verdict
} from "../../src/lib/backup-access/decision";

const START = Date.parse("2026-10-24T10:00:00.000Z");
const MINUTE = 60_000;

function run(
    verdicts: Verdict[],
    base: Partial<DecideInput> = {},
    from: FlipState = INITIAL_STATE
) {
    let state = from;
    const moves: (string | null)[] = [];
    verdicts.forEach((verdict, index) => {
        const result = decide(state, {
            mode: "automatic",
            manualOn: false,
            pathReady: true,
            verdict,
            now: new Date(START + index * MINUTE),
            ...base
        });
        state = result.state;
        moves.push(result.move);
    });
    return { state, moves };
}

describe("backup access flip decision", () => {
    it("does not flip on one failed probe", () => {
        const { state, moves } = run(["down", "up", "down", "down", "up"]);
        expect(moves.every((move) => move === null)).toBe(true);
        expect(state.serving).toBe("direct");
    });

    it("flips to backup after three failures in a row, once", () => {
        const { state, moves } = run(["down", "down", "down", "down", "down"]);
        expect(moves).toEqual([null, null, "to-backup", null, null]);
        expect(state.serving).toBe("backup");
        expect(state.lastFlip?.reason).toBe("outage");
    });

    it("comes back only after enough successes over the window", () => {
        const down = run(["down", "down", "down"]).state;
        // Five successes a minute apart span four minutes: not yet.
        const early = run(["up", "up", "up", "up", "up"], {}, down);
        expect(early.moves.every((move) => move === null)).toBe(true);
        const later = run(["up", "up", "up", "up", "up", "up"], {}, down);
        expect(later.moves.at(-1)).toBe("to-direct");
        expect(later.state.lastFlip?.reason).toBe("recovered");
    });

    it("a failure in the middle restarts the return streak, so it does not flap", () => {
        const down = run(["down", "down", "down"]).state;
        const { moves } = run(["up", "up", "up", "down", "up", "up", "up", "up", "up"], {}, down);
        expect(moves.every((move) => move === null)).toBe(true);
    });

    it("holds still with no uplink: nothing could be written", () => {
        const { state, moves } = run(["no-uplink", "no-uplink", "no-uplink", "no-uplink"]);
        expect(moves.every((move) => move === null)).toBe(true);
        expect(state.uplink).toBe(false);
    });

    it("always on flips at once, manual follows the switch", () => {
        expect(run(["up"], { mode: "always" }).moves).toEqual(["to-backup"]);
        expect(run(["down", "down", "down"], { mode: "manual" }).moves).toEqual([null, null, null]);
        const on = run(["up"], { mode: "manual", manualOn: true });
        expect(on.moves).toEqual(["to-backup"]);
        expect(run(["up"], { mode: "manual", manualOn: false }, on.state).moves).toEqual([
            "to-direct"
        ]);
    });

    it("hands the domain back when the path goes away", () => {
        const down = run(["down", "down", "down"]).state;
        expect(run(["down"], { pathReady: false }, down).moves).toEqual(["to-direct"]);
    });

    it("a re-run on the persisted state decides the same, and survives a restart", () => {
        const { state } = run(["down", "down"]);
        const restored = readState(JSON.stringify(state));
        expect(restored).toEqual(state);
        expect(run(["down"], {}, restored).moves).toEqual(["to-backup"]);
        expect(readState("{not json")).toEqual(INITIAL_STATE);
        expect(readState(JSON.stringify({ serving: "sideways" }))).toEqual(INITIAL_STATE);
    });
});
