/**
 * Reading a container inspect for the fields that say it is looping.
 *
 * The restart count and the start time were always in the body and were simply
 * being dropped on the way out, which is why a server that could never start
 * reported "starting" for as long as anybody watched it. The inspect comes back
 * through the daemon proxy, so every field is read defensively - a junk body has
 * to produce a state, not an exception.
 */

import { describe, expect, it } from "vitest";
import { parseContainerState } from "@polaris/deploy";

describe("parseContainerState", () => {
    it("reads the restart count, which is not under State", () => {
        const state = parseContainerState({
            RestartCount: 7,
            State: { Status: "running", StartedAt: "2026-08-12T21:05:23.101Z" }
        });
        expect(state.restartCount).toBe(7);
        expect(state.startedAt).toBe("2026-08-12T21:05:23.101Z");
        expect(state.status).toBe("running");
    });

    it("keeps the count even when there is no State block to read", () => {
        // The count is what says a container is looping, and a body missing its
        // State is exactly the sort of moment one is.
        expect(parseContainerState({ RestartCount: 3 }).restartCount).toBe(3);
    });

    it("carries the engine's own restarting flag when it is set", () => {
        const state = parseContainerState({ RestartCount: 2, State: { Status: "restarting", Restarting: true } });
        expect(state.restarting).toBe(true);
    });

    it("answers zero rather than throwing for anything unreadable", () => {
        expect(parseContainerState(null).restartCount).toBe(0);
        expect(parseContainerState({ RestartCount: "many" }).restartCount).toBe(0);
        expect(parseContainerState({ State: { Status: "running", StartedAt: 5 } }).startedAt).toBeUndefined();
    });

    it("still reads what it always read", () => {
        const state = parseContainerState({
            State: { Status: "exited", ExitCode: 1, Health: { Status: "unhealthy" } }
        });
        expect(state.status).toBe("exited");
        expect(state.exitCode).toBe(1);
        expect(state.health).toBe("unhealthy");
    });
});
