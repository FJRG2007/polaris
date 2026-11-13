/**
 * The device mesh is an integration an administrator switches on. Before anybody
 * chooses, an install that already used it keeps it and one that never did does
 * not show it; once chosen, the choice wins.
 */

import { describe, expect, it } from "vitest";
import { meshOn, readVpnSettings } from "@/lib/vpn/settings";

describe("meshOn", () => {
    it("is off for a VPN that never set up the control server", () => {
        expect(meshOn(readVpnSettings(undefined))).toBe(false);
        expect(meshOn(readVpnSettings({}))).toBe(false);
    });

    it("stays on for an install that already used it", () => {
        expect(meshOn(readVpnSettings({ enabled: true }))).toBe(true);
        expect(meshOn(readVpnSettings({ apiKey: "sealed" }))).toBe(true);
        expect(meshOn(readVpnSettings({ hostname: "vpn.example.test" }))).toBe(true);
        expect(meshOn(readVpnSettings({ networks: [{ id: "fixture" }] }))).toBe(true);
    });

    it("follows the administrator's choice once made", () => {
        expect(meshOn(readVpnSettings({ apiKey: "sealed", mesh: false }))).toBe(false);
        expect(meshOn(readVpnSettings({ mesh: true }))).toBe(true);
    });
});
