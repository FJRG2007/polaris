/**
 * Who is AFK on a Minecraft server: nobody who has moved, turned their head or
 * fought in the last few minutes - quiet in the chat is not the test.
 */

import { describe, expect, it } from "vitest";
import * as plan from "@polaris-app/game-servers/src/lib/minecraft/events/plan";
import { idleSince } from "@polaris-app/game-servers/src/lib/minecraft/activity";
import { AFK_AFTER_MS } from "@polaris-app/game-servers/src/lib/player-vocabulary";

const at = (name: string, x: number) => [{ name, x, y: 64, z: 0 }];
const looking = (name: string, yaw: number) => new Map([[name, { yaw, pitch: 0 }]]);

describe("since when somebody has done nothing", () => {
    it("counts from when they were first seen, for somebody never seen to move", () => {
        const seen = plan.observe(new Map(), at("Ana", 0), looking("Ana", 0), 1_000);
        expect(idleSince(seen)).toEqual({ Ana: 1_000 });
    });

    it("starts again whenever they move or turn", () => {
        const first = plan.observe(new Map(), at("Ana", 0), looking("Ana", 0), 0);
        const moved = plan.observe(first, at("Ana", 4), looking("Ana", 0), 60_000);
        expect(idleSince(moved)).toEqual({ Ana: 60_000 });
        const turned = plan.observe(moved, at("Ana", 4), looking("Ana", 90), 120_000);
        expect(idleSince(turned)).toEqual({ Ana: 120_000 });
    });

    it("starts again when they fight, even standing still", () => {
        const first = plan.observe(new Map(), at("Ana", 0), looking("Ana", 0), 0, { hit: new Map([["Ana", 5]]) });
        const hitting = plan.observe(first, at("Ana", 0), looking("Ana", 0), 60_000, { hit: new Map([["Ana", 9]]) });
        expect(idleSince(hitting)).toEqual({ Ana: 60_000 });
    });

    it("makes somebody standing still for the whole time AFK after a few minutes", () => {
        let seen = plan.observe(new Map(), at("Ana", 0), looking("Ana", 0), 0);
        for (let minute = 1; minute <= 6; minute += 1) {
            seen = plan.observe(seen, at("Ana", 0.05), looking("Ana", 0.5), minute * 60_000);
        }
        expect(6 * 60_000 - idleSince(seen).Ana!).toBeGreaterThanOrEqual(AFK_AFTER_MS);
    });
});
