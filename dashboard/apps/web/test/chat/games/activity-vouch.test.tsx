// @vitest-environment jsdom

/**
 * Two players finding each other: a claim only counts once the server vouched
 * for it, and until it counts no position goes out or is believed, so a lost
 * answer means neither player ever sees the other. The room's state changes
 * while an answer is on its way, and an answer can come back empty because it
 * was asked too early.
 */

import * as callGame from "@/lib/chat/call-activity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCallActivity, type ActivityApi } from "@/app/(app)/chat/call-activity-panel";

vi.mock("@/app/(app)/chat/call-activity-actions", () => ({}));
vi.mock("@/components/app-extensions/installed-client", () => ({ AppSlotView: () => null }));
vi.mock("@/components/avatar", () => ({ Avatar: () => null }));

const ROOM = "11111111-1111-4111-8111-111111111111";
const claim = (at: number): callGame.ActivityClaim => ({
    game: "new-york",
    at,
    pass: `${Date.now() + callGame.PASS_TTL_MS}.sig`
});
const theirs = callGame.encodeClaim(claim(1));
const room = (activity: string) => new Map([["them", { activity }]]);

function setup(vouch: ActivityApi["vouchCallGames"], overrides: Partial<ActivityApi> = {}) {
    const sendActivity = vi.fn();
    const api = {
        callGames: async () => ({ ok: true as const, seat: "me", games: [] }),
        claimCallGame: async () => ({ claim: claim(2) }),
        renewCallGame: async () => ({ claim: claim(2) }),
        leaveCallGame: async () => undefined,
        vouchCallGames: vouch,
        ...overrides
    } as ActivityApi;
    const stable = {
        participantId: "me",
        meeting: { participants: [{ id: "them", name: "Them" }] },
        setActivity: () => undefined,
        sendActivity,
        listenActivity: () => () => undefined
    };
    const hook = renderHook(
        ({ states }) => useCallActivity(ROOM, { ...stable, states }, true, api),
        { initialProps: { states: new Map<string, { activity?: string }>() } }
    );
    return { hook, sendActivity };
}

const pose = { x: 1, y: 0, z: 2, heading: 0, mode: "car" };

afterEach(() => vi.useRealTimers());

describe("vouching for the other player", () => {
    it("keeps an answer that lands after the room's state changed", async () => {
        let answer = (_: { seats: string[]; now: number }) => undefined as void;
        const vouch = vi.fn(
            () => new Promise<{ seats: string[]; now: number }>((done) => (answer = done))
        );
        const { hook, sendActivity } = setup(vouch);
        await act(async () => hook.result.current.play("new-york"));

        hook.rerender({ states: room(theirs) });
        await waitFor(() => expect(vouch).toHaveBeenCalledTimes(1));
        // Nothing about them changed, but it is a new state: a seat's own
        // attribute coming back is all it takes.
        hook.rerender({ states: room(theirs) });
        await act(async () => answer({ seats: ["them"], now: Date.now() }));

        await waitFor(() => expect(hook.result.current.session?.players).toContain("them"));
        hook.result.current.host?.onState(pose);
        expect(sendActivity).toHaveBeenCalledWith(["them"], {
            kind: "pose",
            game: "new-york",
            pose
        });
    });

    it("asks again about a claim the server could not vouch for yet", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const vouch = vi
            .fn<ActivityApi["vouchCallGames"]>()
            .mockResolvedValueOnce({ seats: [], now: Date.now() })
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValue({ seats: ["them"], now: Date.now() });
        const { hook } = setup(vouch);
        await act(async () => hook.result.current.play("new-york"));

        hook.rerender({ states: room(theirs) });
        for (let round = 0; round < 2; round++) {
            await act(async () => undefined);
            await act(async () => vi.advanceTimersByTime(3100));
        }
        await act(async () => undefined);

        expect(vouch).toHaveBeenCalledTimes(3);
        expect(hook.result.current.session?.players).toContain("them");
    });

    it("stops asking about a claim that is never vouched for", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const vouch = vi.fn(async () => ({ seats: [], now: Date.now() }));
        const { hook } = setup(vouch);
        await act(async () => hook.result.current.play("new-york"));

        hook.rerender({ states: room(theirs) });
        for (let round = 0; round < 10; round++) {
            await act(async () => undefined);
            await act(async () => vi.advanceTimersByTime(3100));
        }

        expect(vouch).toHaveBeenCalledTimes(6);
        expect(hook.result.current.session?.players).toEqual(["me"]);
    });

    it("keeps asking through an outage, which says nothing about the claim", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let down = true;
        const vouch = vi.fn<ActivityApi["vouchCallGames"]>(async () => {
            if (down) throw new Error("offline");
            return { seats: ["them"], now: Date.now() };
        });
        const { hook } = setup(vouch);
        await act(async () => hook.result.current.play("new-york"));

        hook.rerender({ states: room(theirs) });
        for (let round = 0; round < 8; round++) {
            await act(async () => undefined);
            await act(async () => vi.advanceTimersByTime(30_100));
        }
        expect(vouch.mock.calls.length).toBeGreaterThan(7);

        down = false;
        await act(async () => vi.advanceTimersByTime(30_100));
        await act(async () => undefined);
        expect(hook.result.current.session?.players).toContain("them");
    });

    it("waits longer after each request that went unanswered", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const vouch = vi.fn<ActivityApi["vouchCallGames"]>(async () => {
            throw new Error("offline");
        });
        const { hook } = setup(vouch);
        await act(async () => hook.result.current.play("new-york"));

        hook.rerender({ states: room(theirs) });
        await act(async () => undefined);
        expect(vouch).toHaveBeenCalledTimes(1);
        await act(async () => vi.advanceTimersByTime(3100));
        await act(async () => undefined);
        expect(vouch).toHaveBeenCalledTimes(2);
        await act(async () => vi.advanceTimersByTime(3100));
        await act(async () => undefined);
        expect(vouch).toHaveBeenCalledTimes(2);
        await act(async () => vi.advanceTimersByTime(3100));
        await act(async () => undefined);
        expect(vouch).toHaveBeenCalledTimes(3);
    });
});

describe("a request about playing that gets no answer", () => {
    const vouch = async () => ({ seats: [], now: Date.now() });

    it("says so when the claim is lost, until the next answer", async () => {
        const claimCallGame = vi
            .fn<ActivityApi["claimCallGame"]>()
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValue({ claim: claim(2) });
        const { hook } = setup(vouch, { claimCallGame });

        await act(async () => hook.result.current.play("new-york"));
        expect(hook.result.current.failed).toBe(true);
        expect(hook.result.current.busy).toBe(false);

        await act(async () => hook.result.current.play("new-york"));
        expect(hook.result.current.failed).toBe(false);
        expect(hook.result.current.mine).not.toBeNull();
    });

    it("says so when the question is lost, and asking again clears it", async () => {
        const callGames = vi
            .fn<ActivityApi["callGames"]>()
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValue({ ok: true, seat: "me", games: [] });
        const { hook } = setup(vouch, { callGames });

        await waitFor(() => expect(hook.result.current.failed).toBe(true));
        expect(hook.result.current.answer).toBeNull();

        await act(async () => hook.result.current.ask());
        await waitFor(() => expect(hook.result.current.failed).toBe(false));
        expect(hook.result.current.answer?.ok).toBe(true);
    });
});
