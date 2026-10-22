/**
 * The privacy position of a camera with no privacy mode of its own: the ONVIF
 * SetPreset that saves it, and the refusal on a camera that is switched itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ camera: { findFirst: vi.fn(), update: vi.fn() } }));
vi.mock("@polaris/db", () => ({ prisma: db }));

import { setPresetBody } from "@polaris-app/places/src/lib/onvif";
import { clearPrivacyPosition, savePrivacyPosition } from "@polaris-app/places/src/lib/ptz";

const INSTALL = "0192f2a4-6c1e-7c3a-9a40-000000000001";
const CAM = "0192f2a4-6c1e-7c3a-9a40-aaaaaaaaaaaa";

beforeEach(() => {
    db.camera.findFirst.mockReset();
    db.camera.update.mockReset();
});

describe("SetPreset", () => {
    it("saves a new preset under a name, escaped", () => {
        expect(setPresetBody("prof<1>", "Polaris privacy")).toBe(
            '<SetPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>prof&lt;1&gt;</ProfileToken><PresetName>Polaris privacy</PresetName></SetPreset>'
        );
    });

    it("moves the one saved before instead of making a second", () => {
        expect(setPresetBody("p", "Polaris privacy", "7")).toContain(
            "<PresetToken>7</PresetToken></SetPreset>"
        );
    });
});

describe("the privacy position", () => {
    it("is refused on a camera with its own privacy mode", async () => {
        db.camera.findFirst.mockResolvedValue({ vendor: "tapo", privacyPreset: null });
        await expect(savePrivacyPosition(INSTALL, CAM)).rejects.toThrow(
            "This camera has its own privacy mode"
        );
        expect(db.camera.update).not.toHaveBeenCalled();
    });

    it("forgets nothing when there is nothing stored", async () => {
        db.camera.findFirst.mockResolvedValue({ vendor: "onvif", privacyPreset: null });
        await clearPrivacyPosition(INSTALL, CAM);
        expect(db.camera.update).not.toHaveBeenCalled();
    });
});
