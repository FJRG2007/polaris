// @vitest-environment jsdom

/**
 * Location is asked for, not reported blocked, when nobody has answered yet: a
 * browser answers a closed prompt and a real "no" with the same error, and only
 * the permission state tells them apart.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { locate } from "@/lib/geolocation";

function device(answer: "yes" | "no", state: PermissionState | "unknown") {
    vi.stubGlobal("isSecureContext", true);
    Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
            getCurrentPosition: (ok: PositionCallback, fail: PositionErrorCallback) =>
                answer === "yes"
                    ? ok({ coords: { latitude: 40.4, longitude: -3.7, accuracy: 12.4 } } as GeolocationPosition)
                    : fail({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError)
        }
    });
    Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value:
            state === "unknown"
                ? undefined
                : { query: async () => ({ state }) }
    });
}

afterEach(() => vi.unstubAllGlobals());

describe("asking where the device is", () => {
    it("gives the point once allowed", async () => {
        device("yes", "granted");
        expect(await locate()).toEqual({ state: "ready", point: { latitude: 40.4, longitude: -3.7, accuracy: 12 } });
    });

    it("says it still needs asking when the prompt was closed without an answer", async () => {
        device("no", "prompt");
        expect(await locate()).toEqual({ state: "dismissed" });
    });

    it("says blocked only when it really is", async () => {
        device("no", "denied");
        expect(await locate()).toEqual({ state: "denied" });
    });

    it("says blocked where the browser cannot tell", async () => {
        device("no", "unknown");
        expect(await locate()).toEqual({ state: "denied" });
    });
});
