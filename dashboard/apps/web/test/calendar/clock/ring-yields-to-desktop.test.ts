// @vitest-environment jsdom
/**
 * An alarm or timer rings where the account's sounds are made. With the
 * desktop app open and elected to sound, a browser tab leaves the ring to it,
 * as messages and calls already do; and a dashboard that cannot say leaves the
 * tab ringing, because an alarm rung nowhere is the worse mistake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sounding = vi.hoisted(() => ({ another: false as boolean | "missing" }));

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        soundingClient: {
            anotherClientSounds: () => {
                if (sounding.another === "missing") throw new Error("not provided");
                return sounding.another;
            }
        }
    }
}));

import { claim } from "@polaris-app/calendar/src/screens/clock/ringer";

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

    it("rings in the browser when nothing else sounds for the account", async () => {
        sounding.another = false;
        expect(await claim("timer:a:2026-11-10T20:00:00Z")).toBe(true);
    });

    it("leaves the ring to the desktop app while the app sounds", async () => {
        sounding.another = true;
        expect(await claim("timer:b:2026-11-10T20:00:00Z")).toBe(false);
    });

    it("rings anyway on a dashboard that does not say who sounds", async () => {
        sounding.another = "missing";
        expect(await claim("timer:c:2026-11-10T20:00:00Z")).toBe(true);
    });

    it("still rings once per browser", async () => {
        sounding.another = false;
        expect(await claim("timer:d:2026-11-10T20:00:00Z")).toBe(true);
        expect(await claim("timer:d:2026-11-10T20:00:00Z")).toBe(false);
    });
});
