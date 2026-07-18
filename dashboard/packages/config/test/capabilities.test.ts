import { describe, expect, it } from "vitest";
import { deriveCapabilities, LIMITED_CAPABILITIES, type HostdHealth } from "../src/capabilities.js";

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
