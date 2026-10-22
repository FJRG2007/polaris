/**
 * Camera privacy beyond the Tapo wire: targets, a group where one camera
 * refuses, the wall's optimistic switch and its rollback, and the deck key.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import {
    applyPrivacy,
    groupState,
    nextPrivacy,
    parseTarget,
    rollbackPrivacy,
    settlePrivacy,
    targetKey,
    type CameraPrivacy
} from "@polaris-app/places/src/lib/privacy-kinds";
import { groupPrivacy } from "@polaris-app/places/src/lib/privacy";
import { HomeError } from "@polaris-app/places/src/lib/home-error";
import { privacyPress, privacyState } from "@polaris-app/places/src/lib/deck-actions";

const PLACE = "0192f2a4-6c1e-7c3a-9a40-1d2b3c4d5e6f";
const CAM = "0192f2a4-6c1e-7c3a-9a40-aaaaaaaaaaaa";

describe("targets", () => {
    it("round-trips a camera, a zone and a place", () => {
        for (const raw of [`camera:${CAM}`, `place:${PLACE}`, `zone:${PLACE}:Back: garden`]) {
            const parsed = parseTarget(raw);
            expect(parsed).not.toBeNull();
            expect(targetKey(parsed!)).toBe(raw);
        }
    });

    it("refuses anything else", () => {
        for (const raw of ["", "camera:", "camera:1", `room:${PLACE}`, `zone:${PLACE}:`, "zone:x:y"])
            expect(parseTarget(raw)).toBeNull();
    });
});

describe("a group", () => {
    it("switches every camera it can and reports the one that refused", async () => {
        const run = vi.fn(async (id: string): Promise<CameraPrivacy> => {
            if (id === "b")
                return { cameraId: "b", name: "Garden", private: false, native: true, failure: "password" };
            if (id === "c") throw new Error("socket closed");
            return { cameraId: id, name: id, private: true, native: true };
        });
        const results = await groupPrivacy(["a", "b", "c", "d"], run);
        expect(run).toHaveBeenCalledTimes(4);
        expect(results.map((row) => [row.cameraId, row.private, row.failure ?? null])).toEqual([
            ["a", true, null],
            ["b", false, "password"],
            ["c", false, "failed"],
            ["d", true, null]
        ]);
        expect(groupState(results)).toEqual({ all: false, some: 2, total: 4 });
    });

    it("keeps going past a camera that is not this house's", async () => {
        const results = await groupPrivacy(["x", "y"], async (id) => {
            if (id === "x") throw new HomeError("Camera not found");
            return { cameraId: id, name: id, private: true, native: false };
        });
        expect(results[0]!.failure).toBe("failed");
        expect(results[1]!.private).toBe(true);
    });

    it("makes a half-private group whole before turning it off", () => {
        expect(nextPrivacy([{ private: true }, { private: false }])).toBe(true);
        expect(nextPrivacy([{ private: true }, { private: true }])).toBe(false);
        expect(nextPrivacy([])).toBe(true);
    });
});

describe("the wall's switch", () => {
    const wall = [
        { id: "a", privacy: false },
        { id: "b", privacy: false },
        { id: "c", privacy: true }
    ];

    it("shows the change at once, then each camera's own answer", () => {
        const shown = applyPrivacy(wall, ["a", "b"], true);
        expect(shown.map((camera) => camera.privacy)).toEqual([true, true, true]);
        const settled = settlePrivacy(shown, [
            { cameraId: "a", private: true },
            { cameraId: "b", private: false }
        ]);
        expect(settled.map((camera) => camera.privacy)).toEqual([true, false, true]);
    });

    it("puts everything back when the call fails outright", () => {
        const before = new Map([
            ["a", false],
            ["b", false]
        ]);
        const shown = applyPrivacy(wall, ["a", "b"], true);
        expect(rollbackPrivacy(shown, before)).toEqual(wall);
    });
});

describe("the deck key", () => {
    const read = (row: { all: boolean; some: number; total: number }) => ({
        targets: [{ target: `place:${PLACE}`, label: "Home", ...row }]
    });

    it("is on when every camera is private, and counts a partial group", () => {
        expect(privacyState(read({ all: true, some: 3, total: 3 }), "en-US")).toMatchObject({
            tone: "ok",
            on: true,
            detail: "Private"
        });
        expect(privacyState(read({ all: false, some: 1, total: 3 }), "es-ES")).toMatchObject({
            tone: "warn",
            on: false,
            detail: "1/3"
        });
        expect(privacyState(read({ all: false, some: 0, total: 3 }), "en-US")).toMatchObject({
            tone: "idle",
            on: false
        });
        expect(privacyState({}, "en-US")).toMatchObject({ tone: "idle" });
    });

    it("shows the press at once, both ways", () => {
        expect(privacyPress({ tone: "idle", on: false }, "es-ES")).toEqual({
            face: { tone: "ok", on: true, icon: "video-off", detail: "Privada" }
        });
        expect(privacyPress({ tone: "ok", on: true }, "en-US")).toEqual({
            face: { tone: "idle", on: false, icon: "video" }
        });
        expect(privacyPress({ tone: "bad" }, "en-US")).toBeUndefined();
    });
});
