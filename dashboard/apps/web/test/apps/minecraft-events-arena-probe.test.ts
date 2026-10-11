/**
 * The block `arena-service` reads back once an arena is up: the first corner
 * of its last fill. Every fill goes in with `keep`, so a block an earlier fill
 * already put on that corner makes the read-back fail every time - the arena
 * comes down again and the event reports the place as refused.
 */

import { describe, expect, it } from "vitest";
import * as stored from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import { gameOf } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-games";

const PLACE = { x: 300, y: 70, z: -120 };
const PLAYERS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];

function runOf(kind: catalog.EventKind) {
    return stored.runSchema.parse({
        id: "run-1",
        trigger: "manual",
        startedBy: null,
        preset: catalog.newPreset(kind, "probe"),
        phase: "running",
        createdAt: 0,
        startsAt: 0,
        endsAt: 1,
        readyAt: 0,
        joined: [...PLAYERS],
        entrants: [],
        place: PLACE,
        arena: null
    });
}

const covers = (box: stored.Box, x: number, y: number, z: number) =>
    x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2 && z >= box.z1 && z <= box.z2;

describe("an arena's read-back block", () => {
    const kinds = catalog.EVENT_KINDS.filter((kind) => gameOf(kind));

    it("covers every kind played through an arena game", () => {
        expect(kinds.length).toBeGreaterThan(0);
    });

    it.each(kinds)("%s: is placed by its last fill, not one before it", (kind) => {
        const game = gameOf(kind)!;
        const run = runOf(kind);
        const fills = game.fills(run, game.box(run, PLACE));
        const last = fills.at(-1)!;
        const { x1, y1, z1 } = last.box;
        // The same block put there first still reads back as asked for.
        const earlier = fills
            .slice(0, -1)
            .filter((one) => one.block !== last.block && covers(one.box, x1, y1, z1));
        expect(earlier).toEqual([]);
    });
});
