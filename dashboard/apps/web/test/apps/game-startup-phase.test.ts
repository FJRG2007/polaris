/**
 * What a starting server is doing, and which plugin file belongs to which project.
 *
 * Two small rules that exist because of the same wait. A server built on a map
 * spends minutes between the button and the game - fetching a server, fetching a
 * world that is not the server's, unpacking both - and said "starting" for all of
 * it, which is indistinguishable from stuck. And when that wait ended in a crash
 * loop, the cause was a plugin nobody had asked for in three resets: taking it off
 * the list had never taken it off the disk.
 *
 * Every line quoted here came out of a real container.
 */

import { describe, expect, it } from "vitest";
import { isPluginOf } from "@/lib/apps/minecraft/world";
import { startupPhase } from "@/lib/apps/minecraft/parse";

/** The first minute of a server being built, as the image narrates it. */
const BOOTING = [
    "2026-08-12T23:28:06.517917310Z [init] Running as uid=1000 gid=1000 with /data as 'drwxr-x--- 32 1000 1000 4096 Aug 12 23:23 /data'",
    "2026-08-12T23:28:06.521730209Z [init] Resolving type given PAPER",
    "2026-08-12T23:28:10.942262878Z [init] Copying any plugins from /plugins to /data/plugins",
    "2026-08-12T23:28:16.567283119Z [init] Starting the Minecraft server...",
    "2026-08-12T23:28:17.106523552Z Loading libraries, please wait..."
];

describe("what a starting server is doing", () => {
    it("names the step it is on, not the one before it", () => {
        expect(startupPhase(BOOTING.join("\n"))).toBe("Loading the server.");
    });

    it("follows the server through its steps", () => {
        expect(startupPhase(BOOTING.slice(0, 1).join("\n"))).toBe("Getting the container up.");
        expect(startupPhase(BOOTING.slice(0, 2).join("\n"))).toBe("Downloading what it needs.");
        expect(startupPhase(BOOTING.slice(0, 3).join("\n"))).toBe("Putting the settings in place.");
    });

    it("reaches the world, which is the step people wait longest on", () => {
        expect(startupPhase([...BOOTING, '[23:28:23 INFO]: Preparing level "world-20260812-232325"'].join("\n"))).toBe(
            "Building the world."
        );
    });

    it("is not distracted by Polaris asking who is online", () => {
        // These arrive every few seconds while the server cannot answer, so they
        // are always the newest thing in the log and would otherwise be the answer
        // to every question anybody asks of it.
        const noisy = [
            ...BOOTING,
            '[23:28:30 WARN]: Unexpected exception while parsing console command "list"',
            "java.lang.IllegalStateException: Asynchronous command dispatch!"
        ].join("\n");
        expect(startupPhase(noisy)).toBe("Loading the server.");
    });

    it("says nothing about a log with nothing to say", () => {
        expect(startupPhase("[12:00:04 INFO]: Alice joined the game")).toBeNull();
    });
});

describe("which file is which plugin", () => {
    it("finds a plugin under whatever version it was published with", () => {
        expect(isPluginOf("BedWars1058-25.5-SNAPSHOT.jar", "bedwars1058")).toBe(true);
        expect(isPluginOf("GrimAC-2.3.73.jar", "grimac")).toBe(true);
        expect(isPluginOf("CoreProtect-24.0.jar", "coreprotect")).toBe(true);
    });

    it("does not claim a plugin that only starts the same way", () => {
        expect(isPluginOf("BedWars1058-25.5-SNAPSHOT.jar", "grimac")).toBe(false);
        expect(isPluginOf("WorldEdit.jar", "worldguard")).toBe(false);
    });

    it("leaves alone everything that is not a plugin", () => {
        // The folder holds each plugin's settings beside the plugins themselves,
        // and those are kept: a plugin that comes back finds what it was given.
        expect(isPluginOf("BedWars1058", "bedwars1058")).toBe(false);
        expect(isPluginOf("bStats", "bstats")).toBe(false);
    });
});
