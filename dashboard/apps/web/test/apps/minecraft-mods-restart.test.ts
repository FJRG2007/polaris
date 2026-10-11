/**
 * A mod put on or taken off a server's list without a restart waits for one,
 * and the panel draws the same restart card a Polaris login update does until
 * the server has started again since the change.
 */

import { describe, expect, it } from "vitest";
import {
    isModListKey,
    MODS_CHANGED_KEY,
    modsAwaitRestart,
    modsChangedAt
} from "@polaris-app/game-servers/src/lib/minecraft/mods-restart";
import { runSince } from "@polaris-app/game-servers/src/lib/minecraft/run-since";

const at = (iso: string) => new Date(iso);

describe("whether a mod change waits for a restart", () => {
    it("waits when the server came up before the change", () => {
        expect(modsAwaitRestart(at("2026-10-10T12:00:00Z"), at("2026-10-10T09:00:00Z"))).toBe(true);
    });

    it("is done once the server has started since", () => {
        expect(modsAwaitRestart(at("2026-10-10T12:00:00Z"), at("2026-10-10T12:05:00Z"))).toBe(
            false
        );
    });

    it("has nothing waiting on a server that is not up, or that never changed", () => {
        expect(modsAwaitRestart(at("2026-10-10T12:00:00Z"), null)).toBe(false);
        expect(modsAwaitRestart(null, at("2026-10-10T09:00:00Z"))).toBe(false);
    });

    it("reads the moment kept on the install, and nothing it cannot read", () => {
        expect(modsChangedAt({ [MODS_CHANGED_KEY]: "2026-10-10T12:00:00.000Z" })).toEqual(
            at("2026-10-10T12:00:00.000Z")
        );
        expect(modsChangedAt({ [MODS_CHANGED_KEY]: "yesterday" })).toBeNull();
        expect(modsChangedAt({ [MODS_CHANGED_KEY]: 5 })).toBeNull();
        expect(modsChangedAt({})).toBeNull();
    });
});

describe("which settings are a server's mod lists", () => {
    it("names the lists the image installs at boot, and nothing else", () => {
        for (const key of [
            "MODRINTH_PROJECTS",
            "MODRINTH_DOWNLOAD_DEPENDENCIES",
            "MODRINTH_MODPACK",
            "SPIGET_RESOURCES",
            "MODS"
        ]) {
            expect(isModListKey(key)).toBe(true);
        }
        expect(isModListKey("MOTD")).toBe(false);
        expect(isModListKey("VERSION")).toBe(false);
    });
});

describe("when the server's current run began", () => {
    it("is the later of coming online and the last deploy finishing", () => {
        const config = JSON.stringify({ onlineSince: "2026-10-10T09:00:00.000Z" });
        expect(runSince(config, at("2026-10-10T10:00:00Z"))).toEqual(at("2026-10-10T10:00:00Z"));
        expect(runSince(config, at("2026-10-10T08:00:00Z"))).toEqual(
            at("2026-10-10T09:00:00.000Z")
        );
        expect(runSince(config, null)).toEqual(at("2026-10-10T09:00:00.000Z"));
    });

    it("is null for a server not seen online, or a config that does not parse", () => {
        expect(runSince("{}", at("2026-10-10T10:00:00Z"))).toBeNull();
        expect(runSince("not json", null)).toBeNull();
        expect(runSince(null, null)).toBeNull();
    });
});
