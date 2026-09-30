/**
 * Restarting into a version the updater put on disk.
 *
 * A restart signs out of the vault the way a browser restart does, so what is
 * pinned here is when it may happen: never into an older version, never while
 * anything is in flight, and only for a copy the updater's note covers.
 */

import { describe, expect, it } from "vitest";
import { coveredBy, safeToRestart, versionIn, waitingVersion } from "../src/lib/self-update";

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
