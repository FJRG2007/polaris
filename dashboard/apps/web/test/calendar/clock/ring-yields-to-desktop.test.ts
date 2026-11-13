// @vitest-environment jsdom
/**
 * An alarm or timer shows on every open Polaris and sounds on one. Which client
 * sounds is the connection the server elected (`thisClientRings`); within it,
 * one tab of the browser (`claim`). A dashboard that cannot say rings, because
 * an alarm rung nowhere is the worse mistake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sounding = vi.hoisted(() => ({ here: true as boolean | "missing" }));

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        soundingClient: {
            thisClientRings: () => {
                if (sounding.here === "missing") throw new Error("not provided");
                return sounding.here;
            }
        }
    }
}));

import { claim, soundsHere } from "@polaris-app/calendar/src/screens/clock/ringer";

describe("which client rings an alarm", () => {
    const kept = new Map<string, string>();

    beforeEach(() => {
        kept.clear();
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => void kept.set(key, value)
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    it("sounds where the server elected this client", () => {
        sounding.here = true;
        expect(soundsHere()).toBe(true);
    });

    it("stays quiet where another client was elected", () => {
        sounding.here = false;
        expect(soundsHere()).toBe(false);
    });

    it("sounds anyway on a dashboard that does not say who sounds", () => {
        sounding.here = "missing";
        expect(soundsHere()).toBe(true);
    });

    it("claims the sound for one tab per browser, whoever is elected", async () => {
        sounding.here = false;
        expect(await claim("timer:d:2026-11-10T20:00:00Z")).toBe(true);
        expect(await claim("timer:d:2026-11-10T20:00:00Z")).toBe(false);
    });
});
