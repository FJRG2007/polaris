/**
 * "Most events won" on the side panel: counted from every finished event's first
 * place, kept for good rather than read off the history (which forgets after a
 * few dozen), and backfilled from that history on a server that already ran some.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let config: Record<string, unknown> = {};

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({ name: "Survival", config: JSON.stringify(config) })
        }
    }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string) => JSON.parse(raw ?? "{}"),
            patchInstallConfig: async () => undefined
        },
        chatCalls: { voicePresence: async () => new Map() }
    }
}));

const state = await import("@polaris-app/game-servers/src/lib/minecraft/events/state");
const { liveContext } = await import("@polaris-app/game-servers/src/lib/minecraft/live-values");
const { SIDEBAR_BLOCKS } = await import("@polaris-app/game-servers/src/lib/minecraft/sidebar-blocks");

let next = 0;
const ended = (
    podium: { place: number; name: string }[],
    outcome: state.EventHistoryEntry["outcome"] = "finished"
): state.EventHistoryEntry => ({
    id: `h${(next += 1)}`,
    presetId: "rush",
    kind: "mining-rush",
    name: "Mining rush",
    trigger: "manual",
    outcome,
    note: "",
    startedAt: 0,
    endedAt: 1,
    participants: 3,
    podium: podium.map((one) => ({ ...one, score: 10 })),
    disqualified: []
});

beforeEach(() => {
    config = {};
});

describe("events won", () => {
    it("counts each first place, a tie for each, and nothing for second or a cancelled one", () => {
        let kept = state.EMPTY_EVENT_STATE;
        kept = state.withHistory(kept, ended([{ place: 1, name: "Steve" }, { place: 2, name: "Alex" }]));
        kept = state.withHistory(kept, ended([{ place: 1, name: "steve" }]));
        kept = state.withHistory(kept, ended([{ place: 1, name: "Alex" }, { place: 1, name: "Ben" }]));
        kept = state.withHistory(kept, ended([{ place: 1, name: "Alex" }], "cancelled"));
        expect(state.eventWins(kept)).toEqual(
            expect.arrayContaining([
                { name: "steve", value: 2 },
                { name: "Alex", value: 1 },
                { name: "Ben", value: 1 }
            ])
        );
        expect(state.eventWins(kept)).toHaveLength(3);
    });

    it("keeps counting past the history it keeps", () => {
        let kept = state.EMPTY_EVENT_STATE;
        for (let index = 0; index < state.HISTORY_KEPT + 10; index += 1) {
            kept = state.withHistory(kept, ended([{ place: 1, name: "Steve" }]));
        }
        expect(kept.history).toHaveLength(state.HISTORY_KEPT);
        expect(state.eventWins(kept)).toEqual([{ name: "Steve", value: state.HISTORY_KEPT + 10 }]);
    });

    it("counts the history a server already had before the tally existed", () => {
        const old = { ...state.EMPTY_EVENT_STATE, history: [ended([{ place: 1, name: "Alex" }])] };
        const kept = state.withHistory(old, ended([{ place: 1, name: "Alex" }]));
        expect(state.eventWins(old)).toEqual([{ name: "Alex", value: 1 }]);
        expect(state.eventWins(kept)).toEqual([{ name: "Alex", value: 2 }]);
    });

    it("is a leaderboard on the panel, best first, without asking the server", async () => {
        config = {
            eventState: {
                wins: {
                    alex: { name: "Alex", count: 3 },
                    steve: { name: "Steve", count: 7 }
                }
            }
        };
        const context = await liveContext("install", ["{rank.events}"], null, null);
        expect(context.lists?.["rank.events"]).toEqual(["1. Steve 7", "2. Alex 3"]);
        expect(context.values["rank.events"]).toBe("1. Steve 7, 2. Alex 3");
    });

    it("reads as its fallback on a server that has not finished one", async () => {
        const context = await liveContext("install", ["{rank.events}"], null, null);
        expect(context.values["rank.events"]).toBeNull();
    });

    it("is offered as a ready-made block", () => {
        expect(SIDEBAR_BLOCKS.some((block) => block.id === "rank.events")).toBe(true);
    });
});
