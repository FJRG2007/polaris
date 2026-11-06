/**
 * The version last restarted into survives a run, beside what is already kept,
 * and a settings file from before it existed still reads.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const folder = vi.hoisted(() => ({ path: "" }));

vi.mock("electron", () => ({ app: { getPath: () => folder.path } }));

const { hardwareAcceleration, rememberHardwareAcceleration, serverAddress, setUpdateAttempted, updateAttempted } =
    await import("@/main/settings");

beforeEach(() => {
    folder.path = mkdtempSync(join(tmpdir(), "polaris-settings-"));
});

describe("hardware acceleration, read at start", () => {
    it("is on when there is no settings file yet", () => {
        expect(hardwareAcceleration()).toBe(true);
    });

    it("is on for a file written before it existed, and the rest still reads", () => {
        const origin = "https://polaris.example.test";
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ server: origin, servers: [], pushes: {} }));
        expect(hardwareAcceleration()).toBe(true);
        expect(serverAddress()).toBe(origin);
    });

    it("is on when the file is not JSON", () => {
        writeFileSync(join(folder.path, "settings.json"), "{ hardwareAcceleration: fal");
        expect(hardwareAcceleration()).toBe(true);
    });

    it.each([["false"], [0], [null], [{}]])("is on when the value is %j instead of a boolean", (value) => {
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ hardwareAcceleration: value }));
        expect(hardwareAcceleration()).toBe(true);
    });

    it("stays off once turned off, and the address kept beside it survives", () => {
        const origin = "https://polaris.example.test";
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ server: origin }));
        rememberHardwareAcceleration(false);
        expect(hardwareAcceleration()).toBe(false);
        expect(serverAddress()).toBe(origin);
        rememberHardwareAcceleration(true);
        expect(hardwareAcceleration()).toBe(true);
    });
});

describe("the version last restarted into", () => {
    it("reads as none from a file written before it existed, keeping the rest", () => {
        const origin = "https://polaris.example.test";
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ server: origin, servers: [], pushes: {} }));
        expect(updateAttempted()).toBeNull();
        setUpdateAttempted("0.1.3");
        expect(updateAttempted()).toBe("0.1.3");
        expect(serverAddress()).toBe(origin);
    });

    it("falls back to none when the file holds something else", () => {
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ updateAttempted: 3 }));
        expect(updateAttempted()).toBeNull();
    });
});
