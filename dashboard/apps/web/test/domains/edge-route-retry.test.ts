/**
 * Publishing the edge routes on a boot where the database is not up yet.
 *
 * The file this writes carries the call server's path, which is the whole of how
 * a browser reaches the media server. Nothing else writes it on a deployment
 * that never saves a domain or a firewall rule - a house calling between its own
 * rooms never does - so an attempt that fails and is not repeated is a
 * deployment whose calls fail at the first WebSocket for good, with no screen
 * able to say why and no button that repairs it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { publishEdgeRoutes } = await import("@/instrumentation");

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("publishing the routes at startup", () => {
    it("keeps trying until one attempt writes the file", async () => {
        vi.useFakeTimers();
        let attempts = 0;
        // A database still running its migrations answers nothing, and the two
        // reads behind this are both against it.
        const sync = async () => {
            attempts += 1;
            return attempts >= 3;
        };

        const done = publishEdgeRoutes(sync);
        await vi.runAllTimersAsync();
        await done;

        expect(attempts).toBe(3);
    });

    it("stops trying eventually, and says that it has", async () => {
        vi.useFakeTimers();
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        let attempts = 0;

        const done = publishEdgeRoutes(async () => {
            attempts += 1;
            return false;
        });
        await vi.runAllTimersAsync();
        await done;

        // Bounded, so a deployment that genuinely has no dynamic directory does
        // not knock on it forever - and loud, because giving up quietly leaves a
        // support question with no answer in it.
        expect(attempts).toBe(5);
        expect(logged).toHaveBeenCalled();
    });

    it("treats a thrown attempt as one that did not write", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "error").mockImplementation(() => {});
        let attempts = 0;
        const sync = async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("the database is not listening");
            return true;
        };

        const done = publishEdgeRoutes(sync);
        await vi.runAllTimersAsync();
        await done;

        expect(attempts).toBe(2);
    });
});
