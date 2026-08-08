/**
 * What an operator is told about a game port they cannot see from here.
 *
 * The expensive mistake is not silence, it is a confident demand: telling
 * somebody to forward a port that is already forwarded sends them into their
 * router to change something that was never wrong, and when Polaris then ticks it
 * by itself a minute later - because the server had finished starting - it has
 * taught them the page cannot be trusted. So what is asserted here is mostly what
 * the advice refuses to claim.
 */

import { describe, expect, it } from "vitest";
import { gameReachAdvice, type GamePort } from "@/lib/apps/minecraft/reach-advice";

const TCP: readonly GamePort[] = [{ port: 25566, protocol: "tcp" }];
const BLOCKS = { tcp: { start: 25565, end: 25664 }, udp: { start: 19132, end: 19231 } };

describe("a server that is not up yet", () => {
    it("says its port cannot be checked, and asks for nothing", () => {
        const advice = gameReachAdvice("home-nat", TCP, false, "192.168.1.142", "range", BLOCKS, false);

        expect(advice.ok).toBe(false);
        // The whole point: nothing to do, and no mention of the router - there is
        // no evidence about it either way.
        expect(advice.actionable).toBe(false);
        expect(advice.forward).toBe(false);
        expect(advice.steps).toEqual([]);
        expect(`${advice.title} ${advice.detail}`.toLowerCase()).not.toContain("router");
    });
});

describe("a server that is up but unproven", () => {
    it("says it is unconfirmed rather than that nothing has opened it", () => {
        const advice = gameReachAdvice("home-nat", TCP, false, "192.168.1.142", "range", BLOCKS, true);

        expect(advice.forward).toBe(true);
        expect(advice.title).toContain("not confirmed");
        // A forward that exists and one that does not look identical from in here,
        // so the instruction is conditional and the sentence never asserts either.
        expect(advice.detail).not.toContain("nothing has opened it");
        expect(advice.steps[0]).toContain("If it is not open yet");
        expect(advice.steps[0]).toContain("25565-25664");
    });

    it("asks a cloud host about its firewall the same conditional way", () => {
        const advice = gameReachAdvice("vps", TCP, false, null, "range", BLOCKS, true);

        expect(advice.title).toContain("not confirmed");
        expect(advice.steps[0]).toContain("If it is not allowed yet");
    });
});

describe("a server something has arrived on", () => {
    it("is finished, whatever the port is doing this second", () => {
        const advice = gameReachAdvice("home-nat", TCP, true, "192.168.1.142", "range", BLOCKS, false);

        expect(advice.ok).toBe(true);
        expect(advice.actionable).toBe(false);
        expect(advice.title).toContain("Reachable");
    });
});

describe("when nothing was measured", () => {
    it("keeps the old advice for a caller that did not check", () => {
        const advice = gameReachAdvice("home-nat", TCP, false, "192.168.1.142", "range", BLOCKS, null);

        expect(advice.forward).toBe(true);
        expect(advice.actionable).toBe(true);
    });

    it("still refuses to blame a router on a line that cannot receive anything", () => {
        const advice = gameReachAdvice("home-cgnat", TCP, false, null, "range", BLOCKS, true);

        expect(advice.forward).toBe(false);
        expect(advice.title).toContain("cannot receive");
    });
});
