import { describe, expect, it } from "vitest";
import {
    deriveCapabilities,
    getCapabilities,
    setCapabilities,
    LIMITED_CAPABILITIES,
    type HostdHealth
} from "../src/capabilities.js";

const fullHealth: HostdHealth = {
    version: "0.1.0",
    capabilities: {
        hostFilesystem: true,
        nativeMounts: true,
        docker: true,
        kubernetes: false,
        systemd: true,
        autoUpdate: true
    }
};

describe("deriveCapabilities", () => {
    it("returns the limited edition when the daemon is absent", () => {
        expect(deriveCapabilities(null)).toEqual(LIMITED_CAPABILITIES);
    });

    it("promotes to the full edition and mirrors reported capabilities", () => {
        const caps = deriveCapabilities(fullHealth);
        expect(caps.edition).toBe("full");
        expect(caps.hostd).toEqual({ present: true, version: "0.1.0" });
        expect(caps.nativeMounts).toBe(true);
        expect(caps.kubernetes).toBe(false);
    });

    it("lets local policy veto auto-update even when the daemon supports it", () => {
        const caps = deriveCapabilities(fullHealth, { autoUpdateAllowed: false });
        expect(caps.autoUpdate).toBe(false);
        expect(caps.docker).toBe(true);
    });
});

/**
 * The snapshot has to be one answer per process, not one per copy of this
 * module. The built server holds four copies: the probe at startup fills in the
 * one it imported, and everything gated on the answer reads a different one. It
 * fails silently and in the safe-looking direction - a machine with a running
 * daemon quietly takes every limited path - which is why it is pinned here.
 */
describe("the capability snapshot", () => {
    const KEY = Symbol.for("polaris.capabilities.current");

    it("is limited until somebody has probed", () => {
        delete (globalThis as Record<symbol, unknown>)[KEY];
        expect(getCapabilities()).toEqual(LIMITED_CAPABILITIES);
    });

    it("is kept on the process, so every copy of this module reads the one answer", () => {
        delete (globalThis as Record<symbol, unknown>)[KEY];
        const full = deriveCapabilities(fullHealth);
        setCapabilities(full);
        expect((globalThis as Record<symbol, unknown>)[KEY]).toBe(full);
        expect(getCapabilities()).toBe(full);
    });
});
