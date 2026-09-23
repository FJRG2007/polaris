/**
 * Somebody turned away at the door is written down.
 *
 * Read off the live server's whole log while looking into "when a player joined
 * it threw another one out". There was exactly one refusal in the container's
 * entire history, and it was a player being refused on their own join:
 *
 *   Reckmy[/79.157.164.219:53808] logged in with entity id 224582
 *   Reckmy joined the game
 *   Reckmy lost connection: Your account is registered to a different network.
 *
 * Their home connection had been given a new address, which is what a home
 * connection does. The message tells the player to ask the server's owner, and
 * the owner was told nothing anywhere - so the only way they could find out was
 * the player telling them, which is exactly how it reached me.
 */

import { describe, expect, it } from "vitest";
import {
    readRefusals,
    REFUSALS_KEY
} from "@polaris-app/game-servers/src/lib/minecraft/player-access";

const REFUSAL = {
    player: "Reckmy",
    address: "79.157.164.219",
    why: "Your account is registered to a different network. Ask the server's owner to add this one.",
    at: "2026-09-21T20:32:57.000Z"
};

describe("what the owner is told about a refusal", () => {
    it("reads back what was written", () => {
        expect(readRefusals({ [REFUSALS_KEY]: [REFUSAL] })).toEqual([REFUSAL]);
    });

    it("says nothing about a server that has turned nobody away", () => {
        expect(readRefusals({})).toEqual([]);
    });

    it("survives a config written by hand or by an older version", () => {
        // It is a settings blob, and a bad entry must not take down the screen
        // somebody would fix it from.
        expect(readRefusals({ [REFUSALS_KEY]: "nobody" })).toEqual([]);
        expect(readRefusals({ [REFUSALS_KEY]: [{ player: "Reckmy" }, REFUSAL] })).toEqual([REFUSAL]);
        expect(readRefusals({ [REFUSALS_KEY]: [null, 7] })).toEqual([]);
    });

    it("keeps a refusal whose address the log never carried", () => {
        // A join line that has scrolled out leaves the address unknown, and the
        // refusal still happened - it is the part the owner has to see.
        const unknown = { ...REFUSAL, address: null };
        expect(readRefusals({ [REFUSALS_KEY]: [unknown] })[0]?.address).toBeNull();
    });
});
