/**
 * What a server carries for its own sounds: the jar that hands the pack to
 * players live, the switch that keeps the plugin on the list when the login is
 * off, and the server's own resource pack as the fallback where Polaris has no
 * jar. The two ways this goes wrong are a plugin left in a mod loader's folder
 * after a move, and a server pack written over one the operator set.
 */

import { describe, expect, it } from "vitest";
import * as env from "@polaris-app/game-servers/src/lib/minecraft/sounds-env";
import { guardAsTemplate } from "@polaris-app/game-servers/src/lib/minecraft/join-guard";

const ID = "6b7a3c2e-0d59-4f43-9a8b-0c2f3e1d4a5b";
const BASE = "https://polaris.example";
const PAPER_JAR = `${BASE}/api/minecraft/mod/polaris-paper.jar`;
const NEO_JAR = `${BASE}/api/minecraft/mod/polaris-neoforge-1.21.4.jar`;

function vars(entries: Record<string, string>): Map<string, string> {
    return new Map(Object.entries(entries));
}

const enable = { baseUrl: `${BASE}/`, installedAppId: ID, token: "fixture-token", hasToken: false };

describe("which servers hand the sounds out live", () => {
    it("is the mod on NeoForge and the plugin on Paper, Purpur and Spigot", () => {
        expect(env.soundsBuildFor("NEOFORGE", "1.21.4")).toEqual({ kind: "mod", file: "polaris-neoforge-1.21.4.jar" });
        expect(env.soundsBuildFor("PAPER", "1.21.4")).toEqual({ kind: "plugin", file: "polaris-paper.jar" });
        expect(env.soundsBuildFor("PURPUR", "LATEST")).toEqual({ kind: "plugin", file: "polaris-paper.jar" });
        expect(env.soundsBuildFor("FABRIC", "1.21.4")).toBeNull();
        expect(env.soundsBuildFor("VANILLA", "1.21.4")).toBeNull();
        expect(env.soundsBuildFor("PAPER", "1.20.4")).toBeNull();
    });
});

describe("switching sounds on", () => {
    it("puts the plugin on a Paper server with where Polaris is, a token and the switch", () => {
        const writes = env.soundsEnableEnv(vars({ TYPE: "PAPER", VERSION: "1.21.4" }), enable);
        expect(Object.fromEntries(writes)).toEqual({
            MODS: PAPER_JAR,
            POLARIS_URL: BASE,
            POLARIS_SERVER_ID: ID,
            POLARIS_SERVER_TOKEN: "fixture-token",
            POLARIS_SOUNDS: "on"
        });
        expect(env.soundsNeedRestart(writes)).toBe(true);
    });

    it("keeps the token and the address a server already has, and needs no restart when the jar is there", () => {
        const current = vars({
            TYPE: "NEOFORGE",
            VERSION: "1.21.4",
            MODS: NEO_JAR,
            POLARIS_URL: "https://other.example",
            POLARIS_SERVER_ID: ID
        });
        const writes = env.soundsEnableEnv(current, { ...enable, hasToken: true });
        expect(writes.size).toBe(0);
        expect(env.soundsNeedRestart(writes)).toBe(false);
        expect(env.soundsReady(current, ID)).toBe(true);
        expect(env.soundsReady(current, "another-server")).toBe(false);
    });

    it("writes nothing where Polaris has no jar", () => {
        expect(env.soundsEnableEnv(vars({ TYPE: "FABRIC", VERSION: "1.21.4" }), enable).size).toBe(0);
    });
});

describe("the plugin the sounds hold", () => {
    const held = vars({ TYPE: "PAPER", VERSION: "1.21.4", MODS: `https://cdn.example/other.jar,${PAPER_JAR}`, POLARIS_SOUNDS: "on" });

    it("is held only with the switch on and the jar on the list", () => {
        expect(env.soundsHoldPlugin(held)).toBe(true);
        expect(env.soundsHoldPlugin(vars({ ...Object.fromEntries(held), POLARIS_SOUNDS: "" }))).toBe(false);
        expect(env.soundsHoldPlugin(vars({ ...Object.fromEntries(held), MODS: "" }))).toBe(false);
    });

    it("comes off, with the switch, when the server moves to a mod loader", () => {
        const moved = env.soundsMovedTo(held, "FABRIC", "1.21.4");
        expect(moved && Object.fromEntries(moved)).toEqual({ MODS: "https://cdn.example/other.jar", POLARIS_SOUNDS: "" });
    });

    it("stays on a move to another Paper release or to Purpur", () => {
        expect(env.soundsMovedTo(held, "PAPER", "1.21.11")).toBeNull();
        expect(env.soundsMovedTo(held, "PURPUR", "1.21.4")).toBeNull();
    });

    it("is not copied into a template, nor is the switch", () => {
        const template = guardAsTemplate(held);
        expect(template.get("MODS")).toBe("https://cdn.example/other.jar");
        expect(template.has("POLARIS_SOUNDS")).toBe(false);
    });
});

describe("the server's own resource pack", () => {
    const ours = `${BASE}/api/minecraft/sounds/${ID}/abc/latest.zip`;

    it("is free when empty or already the sounds'", () => {
        expect(env.serverPackFree(vars({}), ID)).toBe(true);
        expect(env.serverPackFree(vars({ RESOURCE_PACK: ours }), ID)).toBe(true);
        expect(env.serverPackFree(vars({ RESOURCE_PACK: "https://packs.example/mine.zip" }), ID)).toBe(false);
        expect(env.serverPackIsOurs(vars({ RESOURCE_PACK: ours }), ID)).toBe(true);
        expect(env.serverPackIsOurs(vars({ RESOURCE_PACK: ours }), "6b7a3c2e-0000-4f43-9a8b-0c2f3e1d4a5b")).toBe(false);
    });

    it("is offered with no checksum, so every join fetches the newest, and taken back whole", () => {
        expect(Object.fromEntries(env.serverPackEnv(ours, true))).toEqual({
            RESOURCE_PACK: ours,
            RESOURCE_PACK_SHA1: "",
            RESOURCE_PACK_ENFORCE: "true"
        });
        expect(Object.fromEntries(env.serverPackOffEnv())).toEqual({
            RESOURCE_PACK: "",
            RESOURCE_PACK_SHA1: "",
            RESOURCE_PACK_ENFORCE: "false"
        });
    });
});
