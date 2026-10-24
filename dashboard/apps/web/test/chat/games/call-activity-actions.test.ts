/**
 * Games in a call, as the server decides them: `arcade.calls` to start or join,
 * the app installed, an admitted seat of the reader's own, and a pass nobody
 * else can mint. And `arcade.open` for the Games page itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const MEETING = "0192f6a0-0000-7000-8000-0000000000aa";

const state = vi.hoisted(() => ({
    can: new Set<string>(),
    installed: true,
    seat: { meetingId: "", participantId: "seat-1", admission: "admitted" } as {
        meetingId: string;
        participantId: string;
        admission: string;
    } | null,
    guestSeat: null as { meetingId: string; participantId: string; admission: string } | null,
    games: [
        {
            id: "new-york",
            name: "New York",
            src: "/api/app-bundles/arcade/current/assets/new-york/index.html"
        }
    ]
}));

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "test-secret-for-passes" })
}));
vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "user-1" }),
    sessionCan: async (_user: unknown, permission: string) => state.can.has(permission)
}));
vi.mock("@/lib/chat/meetings", () => ({ seatForUser: async () => state.seat }));
vi.mock("@/lib/chat/meeting-seat", () => ({
    resolveSeat: async () => state.guestSeat ?? state.seat
}));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => state.installed }));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/app-extensions/registry", () => ({ callActivityGames: async () => state.games }));

const actions = await import("@/app/(app)/chat/call-activity-actions");
const passes = await import("@/lib/chat/activity-pass");

beforeEach(() => {
    state.can = new Set(["arcade.calls"]);
    state.installed = true;
    state.seat = { meetingId: MEETING, participantId: "seat-1", admission: "admitted" };
    state.guestSeat = null;
});

describe("arcade.calls on the server", () => {
    it("lists the games for somebody who holds it", async () => {
        const answer = await actions.callGames(MEETING);
        expect(answer).toEqual({ ok: true, seat: "seat-1", games: state.games });
    });

    it("refuses to list or to mint a pass without it", async () => {
        state.can = new Set(["arcade.open", "chat.call"]);
        expect(await actions.callGames(MEETING)).toEqual({ ok: false, reason: "denied" });
        expect(await actions.claimCallGame(MEETING, "new-york")).toEqual({ reason: "denied" });
    });

    it("says the app is missing when Games is not installed or offers no game", async () => {
        state.installed = false;
        expect(await actions.claimCallGame(MEETING, "new-york")).toEqual({ reason: "missing" });
        state.installed = true;
        state.games = [];
        expect(await actions.callGames(MEETING)).toEqual({ ok: false, reason: "missing" });
        state.games = [{ id: "new-york", name: "New York", src: "/x" }];
    });

    it("needs the reader's own admitted seat in that call", async () => {
        state.seat = null;
        expect(await actions.claimCallGame(MEETING, "new-york")).toEqual({ reason: "seat" });
        state.seat = { meetingId: MEETING, participantId: "seat-1", admission: "waiting" };
        expect(await actions.claimCallGame(MEETING, "new-york")).toEqual({ reason: "seat" });
    });

    it("validates its input: a meeting id and a game the app offers", async () => {
        expect(await actions.callGames("not-a-uuid")).toEqual({ ok: false, reason: "seat" });
        expect(await actions.claimCallGame(MEETING, "../../etc")).toEqual({ reason: "missing" });
        expect(await actions.claimCallGame(MEETING, "chess")).toEqual({ reason: "missing" });
        expect(await actions.vouchCallGames(MEETING, "nope")).toEqual([]);
    });
});

describe("renewing a pass", () => {
    async function started() {
        const result = await actions.claimCallGame(MEETING, "new-york");
        if (!("claim" in result)) throw new Error("expected a claim");
        return result.claim;
    }

    it("keeps the moment of joining and gives a fresh pass", async () => {
        const claim = await started();
        const renewed = await actions.renewCallGame(MEETING, claim);
        if (!("claim" in renewed)) throw new Error("expected a claim");
        expect(renewed.claim).toMatchObject({ game: claim.game, at: claim.at });
        expect(
            await actions.vouchCallGames(MEETING, [{ seat: "seat-1", claim: renewed.claim }])
        ).toEqual(["seat-1"]);
    });

    it("is refused once arcade.calls is taken away, the app removed or the seat lost", async () => {
        const claim = await started();
        state.can = new Set(["arcade.open"]);
        expect(await actions.renewCallGame(MEETING, claim)).toEqual({ reason: "denied" });
        state.can = new Set(["arcade.calls"]);
        state.installed = false;
        expect(await actions.renewCallGame(MEETING, claim)).toEqual({ reason: "missing" });
        state.installed = true;
        state.seat = null;
        expect(await actions.renewCallGame(MEETING, claim)).toEqual({ reason: "seat" });
    });

    it("renews only a pass this server minted for the reader's own seat", async () => {
        const claim = await started();
        state.seat = { meetingId: MEETING, participantId: "seat-2", admission: "admitted" };
        expect(await actions.renewCallGame(MEETING, claim)).toEqual({ reason: "seat" });
        state.seat = { meetingId: MEETING, participantId: "seat-1", admission: "admitted" };
        expect(await actions.renewCallGame(MEETING, { ...claim, at: 1 })).toEqual({
            reason: "seat"
        });
        expect(
            await actions.renewCallGame(MEETING, { ...claim, pass: "4102444800000.forged" })
        ).toEqual({
            reason: "seat"
        });
    });

    it("leaves a revoked player out of the game once the old pass runs out", async () => {
        const claim = await started();
        const expires = Number(claim.pass.split(".")[0]);
        expect(expires - Date.now()).toBeLessThanOrEqual(passes.PASS_TTL_MS);
        const session = await import("@/lib/chat/call-activity");
        const people = [{ seat: "seat-1", claim }];
        expect(session.activitySession(people, new Set(["seat-1"]), expires - 1)?.players).toEqual([
            "seat-1"
        ]);
        expect(session.activitySession(people, new Set(["seat-1"]), expires)).toBeNull();
    });
});

describe("a pass", () => {
    it("is minted for the seat and vouched for by anybody seated in the call", async () => {
        const result = await actions.claimCallGame(MEETING, "new-york");
        if (!("claim" in result)) throw new Error("expected a claim");
        state.seat = { meetingId: MEETING, participantId: "seat-2", admission: "admitted" };
        state.can = new Set();
        expect(
            await actions.vouchCallGames(MEETING, [{ seat: "seat-1", claim: result.claim }])
        ).toEqual(["seat-1"]);
    });

    it("opens nothing for another seat, game, moment or call, or once expired", async () => {
        const result = await actions.claimCallGame(MEETING, "new-york");
        if (!("claim" in result)) throw new Error("expected a claim");
        const { claim } = result;
        expect(await actions.vouchCallGames(MEETING, [{ seat: "seat-9", claim }])).toEqual([]);
        expect(
            await actions.vouchCallGames(MEETING, [
                { seat: "seat-1", claim: { ...claim, at: claim.at + 1 } }
            ])
        ).toEqual([]);
        expect(
            await actions.vouchCallGames(MEETING, [
                { seat: "seat-1", claim: { ...claim, game: "other" } }
            ])
        ).toEqual([]);
        expect(
            passes.readActivityPass(claim.pass, {
                meetingId: "0192f6a0-0000-7000-8000-0000000000bb",
                seat: "seat-1",
                game: claim.game,
                at: claim.at
            })
        ).toBe(false);
        const facts = { meetingId: MEETING, seat: "seat-1", game: "new-york", at: 5 };
        const old = passes.activityPass(facts, 0);
        expect(passes.readActivityPass(old, facts, passes.PASS_TTL_MS + 1)).toBe(false);
        expect(passes.readActivityPass(`${old}.x`, facts, 1)).toBe(false);
        expect(passes.readActivityPass("forged.sig", facts)).toBe(false);
    });

    it("is not vouched for to somebody without a seat in the call", async () => {
        const result = await actions.claimCallGame(MEETING, "new-york");
        if (!("claim" in result)) throw new Error("expected a claim");
        state.seat = null;
        expect(
            await actions.vouchCallGames(MEETING, [{ seat: "seat-1", claim: result.claim }])
        ).toEqual([]);
    });
});
