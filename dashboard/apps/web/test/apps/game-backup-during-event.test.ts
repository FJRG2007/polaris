/**
 * A scheduled world copy holds the server's tick for seconds (`save-all
 * flush`), so it waits while an event is counting down or being played.
 */

import { describe, expect, it } from "vitest";
import { eventUnderway } from "@polaris-app/game-servers/src/lib/minecraft/world-service";
import { EVENT_STATE_KEY } from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";

describe("a scheduled world copy during an event", () => {
    it("waits while a run is under way", () => {
        expect(eventUnderway({ [EVENT_STATE_KEY]: { run: { phase: "running" } } })).toBe(true);
    });

    it("goes ahead with no run, no event state, or a malformed one", () => {
        expect(eventUnderway({ [EVENT_STATE_KEY]: { run: null } })).toBe(false);
        expect(eventUnderway({})).toBe(false);
        expect(eventUnderway({ [EVENT_STATE_KEY]: "broken" })).toBe(false);
    });
});
