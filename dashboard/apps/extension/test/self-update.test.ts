/**
 * Restarting into a version the updater put on disk.
 *
 * A restart signs out of the vault the way a browser restart does, so what is
 * pinned here is when it may happen: never into an older version, never while
 * anything is in flight, and only for a copy the updater's note covers.
 */

import { describe, expect, it } from "vitest";
import {
    coveredBy,
    installLine,
    INSTALL_LINES,
    lastCheck,
    safeToRestart,
    updaterTrouble,
    versionIn,
    waitingVersion
} from "../src/lib/self-update";

describe("the updater's note", () => {
    it("covers a copy the task or the job keeps current", () => {
        expect(coveredBy({ updater: "windows-task", tag: "extension-v0.1.13" })).toBe(true);
        expect(coveredBy({ updater: "systemd" })).toBe(true);
    });

    it("does not cover a pinned install, or anything unreadable", () => {
        expect(coveredBy({ updater: "none" })).toBe(false);
        expect(coveredBy({ updater: "" })).toBe(false);
        expect(coveredBy({})).toBe(false);
        expect(coveredBy(null)).toBe(false);
        expect(coveredBy("windows-task")).toBe(false);
    });
});

describe("the version on disk", () => {
    it("is read from the manifest, or not at all", () => {
        expect(versionIn({ version: "0.1.13" })).toBe("0.1.13");
        expect(versionIn({ version: 13 })).toBeNull();
        expect(versionIn(null)).toBeNull();
    });

    it("waits only when it is newer than the one running", () => {
        expect(waitingVersion("0.1.12", "0.1.13")).toBe("0.1.13");
        expect(waitingVersion("0.1.13", "0.1.13")).toBeNull();
        // An older release put back by hand: not a restart to make.
        expect(waitingVersion("0.1.13", "0.1.12")).toBeNull();
        expect(waitingVersion("0.1.12", null)).toBeNull();
    });
});

describe("when a restart may happen", () => {
    const idle = {
        vaultOpen: false,
        accountsParked: false,
        holdingLogin: false,
        awaitingApproval: false,
        popupOpen: false,
        answering: false
    };

    it("is when nothing is going on", () => {
        expect(safeToRestart(idle)).toBe(true);
    });

    it("is never while anything would be cut short", () => {
        for (const key of Object.keys(idle) as (keyof typeof idle)[]) {
            expect(safeToRestart({ ...idle, [key]: true })).toBe(false);
        }
    });
});

describe("the updater's last run (BUG-0022)", () => {
    const HOUR = 60 * 60 * 1000;
    const at = Date.UTC(2026, 10, 23, 12);
    const note = (check: Record<string, unknown> | undefined, updater = "windows-task") => ({
        updater,
        tag: "extension-v0.1.275",
        ...(check ? { check } : {})
    });
    const ran = (outcome: string, reason: string | null = null, detail: string | null = null) => ({
        at: new Date(at).toISOString(),
        outcome,
        reason,
        detail,
        everyMinutes: 60
    });

    it("reads the check the scripts write, and nothing that is not one", () => {
        expect(lastCheck(note(ran("current")))).toEqual({
            at,
            outcome: "current",
            reason: null,
            detail: null,
            everyMinutes: 60
        });
        expect(lastCheck(note(undefined))).toBeNull();
        expect(lastCheck(note({ ...ran("current"), at: "yesterday" }))).toBeNull();
        expect(lastCheck(note({ ...ran("exploded") }))).toBeNull();
        expect(lastCheck(note({ ...ran("current"), everyMinutes: -1 }))?.everyMinutes).toBe(60);
        expect(lastCheck(note(ran("failed", "install", "x".repeat(1000))))?.detail).toHaveLength(300);
    });

    it("says nothing for an updater too old to write a check, or a pinned copy", () => {
        expect(updaterTrouble(note(undefined), at + 100 * HOUR, true)).toBeNull();
        expect(updaterTrouble(note(ran("failed", "task"), "none"), at, true)).toBeNull();
    });

    it("reports a failure at once, in the updater's words", () => {
        expect(updaterTrouble(note(ran("failed", "digest", "extension-v0.1.276")), at, false)).toEqual({
            reason: "digest",
            detail: "extension-v0.1.276",
            at
        });
        expect(updaterTrouble(note(ran("failed", "something-new")), at, false)?.reason).toBe("unknown");
    });

    it("lets GitHub being out of reach pass while nothing newer is waiting", () => {
        expect(updaterTrouble(note(ran("failed", "unreachable")), at, false)).toBeNull();
        expect(updaterTrouble(note(ran("failed", "unreachable")), at, true)?.reason).toBe("unreachable");
    });

    it("calls an updater stopped once a newer version has waited three of its runs", () => {
        const fine = note(ran("current"));
        expect(updaterTrouble(fine, at + 3 * HOUR, true)).toBeNull();
        expect(updaterTrouble(fine, at + 3 * HOUR + 1, true)).toEqual({ reason: "stopped", detail: null, at });
        expect(updaterTrouble(fine, at + 30 * HOUR, false)).toBeNull();
        // A clock moved backwards is not hours of silence.
        expect(updaterTrouble(fine, at - 10 * HOUR, true)).toBeNull();
    });

    it("hands each system its own install line", () => {
        expect(installLine("win")).toBe(INSTALL_LINES.windows);
        expect(installLine("mac")).toBe(INSTALL_LINES.unix);
        expect(installLine("linux")).toBe(INSTALL_LINES.unix);
        expect(installLine(null)).toBe(INSTALL_LINES.unix);
    });
});
