/**
 * The Tuning tab compares memory by size, however the engine wrote it, so a
 * setting applied as suggested reads as applied.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/apps/deploy/database-actions", () => ({}));

import { readableSetting, settingDiffers } from "@/app/(app)/apps/deploy/database-tuning-panel";

describe("settingDiffers", () => {
    it("reads PostgreSQL's largest exact unit as the size suggested in megabytes", () => {
        expect(settingDiffers("1GB", "1024MB")).toBe(false);
        expect(settingDiffers("3GB", "3072MB")).toBe(false);
        expect(settingDiffers("128MB", "1024MB")).toBe(true);
        expect(settingDiffers("4096kB", "4MB")).toBe(false);
    });

    it("compares MySQL's bytes and plain counts as written", () => {
        expect(settingDiffers(String(1024 ** 3), String(1024 ** 3))).toBe(false);
        expect(settingDiffers("100", "200")).toBe(true);
        expect(settingDiffers("151", "151")).toBe(false);
        expect(settingDiffers(null, "151")).toBe(true);
    });
});

describe("readableSetting", () => {
    it("shows the same size the same way whichever unit it came in", () => {
        expect(readableSetting("1GB")).toBe("1GB");
        expect(readableSetting("1024MB")).toBe("1GB");
        expect(readableSetting(String(1024 ** 3))).toBe("1GB");
        expect(readableSetting("512kB")).toBe("512kB");
        expect(readableSetting("200")).toBe("200");
        expect(readableSetting(null)).toBe("-");
    });
});
