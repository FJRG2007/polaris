/**
 * A server that goes quiet on its own.
 *
 * Two different things are called "stop it when nobody is playing" and only one
 * of them is what people mean. Polaris's schedule stops the container: the memory
 * comes back and somebody has to start the server again. The server's own pause -
 * `pause-when-empty-seconds`, in Minecraft since 1.21.2 - stops it ticking while
 * keeping its address, and it comes back the instant somebody connects.
 *
 * Verified against a real server: a 1.21.4 container started on a world and
 * logged "Server empty for 60 seconds, pausing" with nothing configured, because
 * 60 is the game's own default. What is pinned here is that Polaris offers the
 * setting, and offers it in a shape the image will accept.
 */

import { describe, expect, it } from "vitest";
import { envFormatHint, findApp, isAllowedEnvValue, tunableEnvVars } from "@/lib/apps/catalog";

const field = () => findApp("minecraft")?.template?.env?.find((entry) => entry.key === "PAUSE_WHEN_EMPTY_SECONDS");

describe("pausing a server that nobody is on", () => {
    it("is a setting a server already running can be given", () => {
        // Tunable is the whole point: the servers worth pausing are the ones that
        // already exist, and a field that is not tunable can only be set at create.
        expect(tunableEnvVars(findApp("minecraft")!).some((entry) => entry.key === "PAUSE_WHEN_EMPTY_SECONDS")).toBe(
            true
        );
    });

    it("defaults to the same minute the game itself does", () => {
        expect(field()?.default).toBe("60");
    });

    it("takes a whole number of seconds and nothing else", () => {
        const entry = field()!;
        expect(isAllowedEnvValue(entry, "60")).toBe(true);
        expect(isAllowedEnvValue(entry, "0")).toBe(true);
        // The property is read as an integer; anything else is a server that
        // refuses the property with the reason in a log nobody opens.
        expect(isAllowedEnvValue(entry, "60s")).toBe(false);
        expect(isAllowedEnvValue(entry, "1.5")).toBe(false);
        expect(isAllowedEnvValue(entry, "")).toBe(false);
        expect(envFormatHint(entry)).toBe("give a whole number of seconds");
    });

    it("says what it does rather than what it is called", () => {
        expect(field()?.label).toBe("Pause when nobody is playing");
        expect(field()?.help).toContain("comes back the moment somebody joins");
    });
});
