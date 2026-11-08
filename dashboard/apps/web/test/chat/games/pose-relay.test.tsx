// @vitest-environment jsdom

/**
 * Two players in one room, through the real activity hook: what one frame
 * reports reaches the other frame, again and again, under one name.
 */

import { describe, expect, it, vi } from "vitest";
import * as callGame from "@/lib/chat/call-activity";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCallActivity, type ActivityApi } from "@/app/(app)/chat/call-activity-panel";

vi.mock("@/app/(app)/chat/call-activity-actions", () => ({}));
vi.mock("@/components/app-extensions/installed-client", () => ({ AppSlotView: () => null }));
vi.mock("@/components/avatar", () => ({ Avatar: () => null }));

const ROOM = "11111111-1111-4111-8111-111111111111";
const NAMES: Record<string, string> = { me: "Me", arnau: "Arnau" };

type Listener = (from: string, raw: unknown) => void;

function player(seat: string, other: string, bus: Map<string, Listener>) {
    let at = seat === "me" ? 1 : 2;
    const api = {
        callGames: async () => ({ ok: true as const, seat, games: [] }),
        claimCallGame: async () => ({
            claim: { game: "new-york", at: at++, pass: `${Date.now() + callGame.PASS_TTL_MS}.sig` }
        }),
        renewCallGame: async () => ({ reason: "seat" as const }),
        leaveCallGame: async () => undefined,
        vouchCallGames: async () => ({ seats: [other], now: Date.now() })
    } as unknown as ActivityApi;
    const transport = {
        participantId: seat,
        meeting: { participants: [{ id: other, name: NAMES[other]! }] },
        setActivity: (claim: string) => setTheirs.current?.(claim),
        sendActivity: (to: readonly string[], message: unknown) => {
            for (const target of to) bus.get(target)?.(seat, JSON.parse(JSON.stringify(message)));
        },
        listenActivity: (listener: Listener) => {
            bus.set(seat, listener);
            return () => {
                if (bus.get(seat) === listener) bus.delete(seat);
            };
        }
    };
    const setTheirs: { current: ((claim: string) => void) | null } = { current: null };
    return { api, transport, setTheirs };
}

describe("a position travels between two players", () => {
    it("reaches the other frame with every move, under one entry", async () => {
        const bus = new Map<string, Listener>();
        const a = player("me", "arnau", bus);
        const b = player("arnau", "me", bus);
        const states = { me: new Map(), arnau: new Map() } as Record<
            string,
            Map<string, { activity?: string }>
        >;
        const hookA = renderHook(
            ({ s }) => useCallActivity(ROOM, { ...a.transport, states: s }, true, a.api),
            { initialProps: { s: states.me! } }
        );
        const hookB = renderHook(
            ({ s }) => useCallActivity(ROOM, { ...b.transport, states: s }, true, b.api),
            { initialProps: { s: states.arnau! } }
        );
        // Each one's attribute is what the other sees of them
        a.setTheirs.current = (claim) => hookB.rerender({ s: new Map([["me", { activity: claim }]]) });
        b.setTheirs.current = (claim) => hookA.rerender({ s: new Map([["arnau", { activity: claim }]]) });

        await act(async () => hookA.result.current.play("new-york"));
        await act(async () => hookB.result.current.play("new-york"));
        await waitFor(() => expect(hookA.result.current.host).not.toBeNull());
        await waitFor(() => expect(hookB.result.current.host).not.toBeNull());

        const seen: callGame.FramePlayer[][] = [];
        hookA.result.current.host!.onPlayers((players) => seen.push(players));

        for (let step = 0; step < 4; step++) {
            await act(async () => {
                hookB.result.current.host!.onState({ x: step * 10, y: 0, z: 0, heading: 0, mode: "car" });
                await new Promise((done) => setTimeout(done, 160));
            });
        }
        const last = seen.at(-1)!;
        expect(last).toHaveLength(1);
        expect(last[0]).toMatchObject({ id: "arnau", name: "Arnau", x: 30 });
        const xs = new Set(seen.flat().map((p) => p.x));
        expect(xs.size).toBeGreaterThanOrEqual(3);
    });
});
