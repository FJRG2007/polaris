/**
 * Enigma is on for a Polar Code session unless a tier says otherwise: with no
 * setting anywhere the boot gets the full install, and only a stored `false`
 * turns it off.
 */

import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";

describe("Enigma in a Code session", () => {
    it("installs everything when nobody decided anything", () => {
        const resolved = core.resolveEnigma(core.INHERIT_ENIGMA, null, undefined);
        expect(resolved.enabled).toBe(true);
        expect(resolved.scope).toBe("all");
        expect(core.enigmaSetupScript(resolved)).toContain("npm install -g");
        expect(core.enigmaConfigureScript(resolved)).toContain("enigma install --all --yes");
    });

    it("stays off only where somebody switched it off", () => {
        const off = core.resolveEnigma({ ...core.INHERIT_ENIGMA, enabled: false });
        expect(core.enigmaSetupScript(off)).toBe("");
        expect(core.enigmaConfigureScript(off)).toBe("");
    });

    it("lets a nearer tier switch it back on", () => {
        const on = core.resolveEnigma(
            { ...core.INHERIT_ENIGMA, enabled: true },
            { ...core.INHERIT_ENIGMA, enabled: false }
        );
        expect(on.enabled).toBe(true);
    });
});
