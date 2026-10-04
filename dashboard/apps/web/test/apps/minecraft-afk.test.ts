/**
 * Who is AFK on a Minecraft server: nobody who has moved or turned their head in
 * the events' AFK minutes - quiet in the chat is not the test, and neither is a
 * fight, which mobs at a farm bring to a player who is not there.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as plan from "@polaris-app/game-servers/src/lib/minecraft/events/plan";
import type { ServerContainer } from "@polaris-app/game-servers/src/lib/minecraft/service";
import {
    forgetActivity,
    idleSince,
    lookIfDue
} from "@polaris-app/game-servers/src/lib/minecraft/activity";

const at = (name: string, x: number) => [{ name, x, y: 64, z: 0 }];
const looking = (name: string, yaw: number) => new Map([[name, { yaw, pitch: 0 }]]);

describe("who is AFK, and since when", () => {
    it("counts from when they were first seen, for somebody never seen to move", () => {
        const seen = plan.observe(new Map(), at("Ana", 0), looking("Ana", 0), 1_000);
        expect(idleSince(seen, 5, 1_000 + 4 * 60_000)).toEqual({});
        expect(idleSince(seen, 5, 1_000 + 5 * 60_000)).toEqual({ Ana: 1_000 });
    });

    it("starts again whenever they move or turn", () => {
        const first = plan.observe(new Map(), at("Ana", 0), looking("Ana", 0), 0);
        const moved = plan.observe(first, at("Ana", 4), looking("Ana", 0), 60_000);
        expect(idleSince(moved, 5, 6 * 60_000)).toEqual({ Ana: 60_000 });
        const turned = plan.observe(moved, at("Ana", 4), looking("Ana", 90), 120_000);
        expect(idleSince(turned, 5, 6 * 60_000)).toEqual({});
    });

    it("does not start again when they fight standing still", () => {
        const first = plan.observe(new Map(), at("Ana", 0), looking("Ana", 0), 0, {
            hit: new Map([["Ana", 5]])
        });
        const hitting = plan.observe(first, at("Ana", 0), looking("Ana", 0), 60_000, {
            hit: new Map([["Ana", 9]])
        });
        expect(idleSince(hitting, 5, 5 * 60_000)).toEqual({ Ana: 0 });
    });

    it("uses the AFK minutes the events are set to", () => {
        const seen = plan.observe(new Map(), at("Ana", 0), looking("Ana", 0), 0);
        expect(idleSince(seen, 10, 6 * 60_000)).toEqual({});
        expect(idleSince(seen, 2, 6 * 60_000)).toEqual({ Ana: 0 });
    });

    it("makes somebody standing still for the whole time AFK after a few minutes", () => {
        let seen = plan.observe(new Map(), at("Ana", 0), looking("Ana", 0), 0);
        for (let minute = 1; minute <= 6; minute += 1) {
            seen = plan.observe(seen, at("Ana", 0.05), looking("Ana", 0.5), minute * 60_000);
        }
        expect(idleSince(seen, 5, 6 * 60_000)).toEqual({ Ana: 0 });
    });
});

describe("looking at who is on", () => {
    afterEach(() => forgetActivity());

    it("shares a look still under way instead of starting another", async () => {
        const say = vi.fn(() => new Promise<string>((resolve) => setTimeout(() => resolve(""), 5)));
        const server = { say, sayAll: vi.fn(async () => "") } as unknown as ServerContainer;
        const [first, second] = await Promise.all([
            lookIfDue("srv-test", server),
            lookIfDue("srv-test", server)
        ]);
        expect(first).toBe(second);
        expect(say).toHaveBeenCalledTimes(5);
    });
});
