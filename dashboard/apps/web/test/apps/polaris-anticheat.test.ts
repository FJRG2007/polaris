/**
 * What a server has to carry for Polaris's anti-cheat engine, and where it may.
 *
 * What is pinned: it runs on Paper and the servers built on it, Folia and Spigot,
 * and nowhere a mod loader changes how players move; switching it on puts one
 * entry on `MODS` beside everything else there - the login's jar included - and
 * off takes only that entry away, writing the list even when that empties it; a
 * settings save that moves the server to software it cannot run on takes it off,
 * without disturbing what the login's own rules write and without deciding against
 * it; and the image builds and serves the file.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
    guardAsTemplate,
    guardForSave
} from "@polaris-app/game-servers/src/lib/minecraft/join-guard";
import * as anticheat from "@polaris-app/game-servers/src/lib/minecraft/polaris-anticheat";

const BASE = "https://polaris.example";
const JAR = `${BASE}/api/minecraft/mod/polaris-anticheat-bukkit.jar`;
const LOGIN = `${BASE}/api/minecraft/mod/polaris-paper.jar`;
const SERVER = "01a0a00b-35c5-7932-861e-1b2161a9b298";

describe("where the engine runs", () => {
    it("is Paper and the servers built on it, Folia and Spigot", () => {
        for (const software of ["PAPER", "PURPUR", "PUFFERFISH", "LEAF", "FOLIA", "SPIGOT"]) {
            expect(anticheat.anticheatRunsOn(software), software).toBe(true);
        }
    });

    it("is nowhere a mod loader or a limbo runs", () => {
        for (const software of [
            "VANILLA",
            "FABRIC",
            "NEOFORGE",
            "FORGE",
            "ARCLIGHT",
            "MOHIST",
            "LIMBO",
            ""
        ]) {
            expect(anticheat.anticheatRunsOn(software), software).toBe(false);
        }
    });
});

describe("switching it", () => {
    it("puts one entry on the list beside everything already there, and where to report", () => {
        const current = new Map([["MODS", `${LOGIN},https://elsewhere.example/other.jar`]]);
        const input = { baseUrl: `${BASE}/`, installedAppId: SERVER, token: "secret" };
        const on = anticheat.anticheatEnableEnv(current, input);
        expect(on.get("MODS")).toBe(`${LOGIN},https://elsewhere.example/other.jar,${JAR}`);
        expect(on.get("POLARIS_ANTICHEAT")).toBe("on");
        expect(on.get("POLARIS_URL")).toBe(BASE);
        expect(on.get("POLARIS_SERVER_ID")).toBe(SERVER);
        expect(anticheat.anticheatOn(on)).toBe(true);
        // The token is a secret; nothing else is.
        expect(
            anticheat
                .anticheatEnvWrites(on)
                .filter((one) => one.isSecret)
                .map((one) => one.key)
        ).toEqual(["POLARIS_SERVER_TOKEN"]);
        // Twice is still once.
        expect(
            anticheat
                .anticheatEnableEnv(on, input)
                .get("MODS")!
                .split(",")
                .filter((one) => one === JAR)
        ).toHaveLength(1);
    });

    it("takes only its own entry off, and writes the list even when that empties it", () => {
        const off = anticheat.anticheatDisableEnv(new Map([["MODS", `${LOGIN},${JAR}`]]));
        expect(off.get("MODS")).toBe(LOGIN);
        expect(off.get("POLARIS_ANTICHEAT")).toBe("off");
        expect(anticheat.anticheatDisableEnv(new Map([["MODS", JAR]])).get("MODS")).toBe("");
    });

    it("is not on with only the switch, or only the jar", () => {
        expect(anticheat.anticheatOn(new Map([["POLARIS_ANTICHEAT", "on"]]))).toBe(false);
        expect(anticheat.anticheatOn(new Map([["MODS", JAR]]))).toBe(false);
    });
});

describe("a settings save that moves the server", () => {
    const running = { TYPE: "PAPER", VERSION: "1.21.4", MODS: JAR, POLARIS_ANTICHEAT: "on" };
    const reader = (env: Record<string, string>) => vi.fn(async () => new Map(Object.entries(env)));

    it("takes the engine off software it cannot run on", async () => {
        const writes = new Map(
            (await guardForSave([{ key: "TYPE", value: "FABRIC" }], reader(running))).map((one) => [
                one.key,
                one.value
            ])
        );
        expect(writes.get("MODS")).toBe("");
        // Nobody turned it off: a move back gets it on again by default.
        expect(writes.get("POLARIS_ANTICHEAT")).toBe("");
        expect(anticheat.wantsDefaultAnticheat(new Map([...writes, ["TYPE", "PAPER"]]))).toBe(true);
    });

    it("leaves it on software it runs on, without reading the environment for it", async () => {
        const read = reader(running);
        const writes = await guardForSave([{ key: "TYPE", value: "PURPUR" }], read);
        expect(writes.some((one) => one.key === "POLARIS_ANTICHEAT")).toBe(false);
    });
});

describe("the image", () => {
    it("builds the file the route serves, with the version beside it, into the Game servers bundle", () => {
        const dockerfile = readFileSync(
            join(__dirname, "..", "..", "..", "..", "docker", "Dockerfile"),
            "utf8"
        );
        for (const file of anticheat.ANTICHEAT_FILES) {
            expect(dockerfile).toContain(`/out/${file}`);
            expect(dockerfile).toContain(`/out/${file}.version`);
        }
        expect(dockerfile).toContain(
            "COPY --from=minecraft-anticheat /out ./apps/game-servers/.assets/minecraft-mods"
        );
        expect(dockerfile.indexOf("COPY --from=minecraft-anticheat")).toBeLessThan(
            dockerfile.indexOf("RUN node packages/app-host/bundler/build.mjs")
        );
    });

    it("parses: every line outside a continuation is a comment, blank or an instruction", () => {
        const dockerfile = readFileSync(
            join(__dirname, "..", "..", "..", "..", "docker", "Dockerfile"),
            "utf8"
        );
        const instruction =
            /^(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\s/i;
        let continued = false;
        const stray: string[] = [];
        for (const line of dockerfile.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (
                !continued &&
                trimmed !== "" &&
                !trimmed.startsWith("#") &&
                !instruction.test(trimmed)
            )
                stray.push(line);
            if (trimmed.startsWith("#") && continued) continue;
            continued = trimmed.endsWith("\\");
        }
        expect(stray).toEqual([]);
    });
});

describe("on by default", () => {
    it("wants it where it runs and nobody decided, and keeps an owner's off", () => {
        expect(anticheat.wantsDefaultAnticheat(new Map([["TYPE", "PAPER"]]))).toBe(true);
        expect(
            anticheat.wantsDefaultAnticheat(
                new Map([
                    ["TYPE", "PAPER"],
                    ["POLARIS_ANTICHEAT", "off"]
                ])
            )
        ).toBe(false);
        expect(
            anticheat.wantsDefaultAnticheat(
                new Map([
                    ["TYPE", "PAPER"],
                    ["POLARIS_ANTICHEAT", "on"]
                ])
            )
        ).toBe(false);
        expect(anticheat.wantsDefaultAnticheat(new Map([["TYPE", "NEOFORGE"]]))).toBe(false);
    });

    it("takes the anti-cheat it replaces off the Modrinth list when it goes on, and nothing else", () => {
        expect(anticheat.withoutReplacedAnticheats("grimac?:alpha,coreprotect?,luckperms?")).toBe(
            "coreprotect?,luckperms?"
        );
        const on = anticheat.anticheatEnableEnv(
            new Map([["MODRINTH_PROJECTS", "GrimAC?:alpha,coreprotect?"]]),
            { baseUrl: BASE, installedAppId: SERVER, token: "t" }
        );
        expect(on.get("MODRINTH_PROJECTS")).toBe("coreprotect?");
        // A list that had nothing to take off is not written at all.
        const plain = anticheat.anticheatEnableEnv(
            new Map([["MODRINTH_PROJECTS", "coreprotect?"]]),
            {
                baseUrl: BASE,
                installedAppId: SERVER,
                token: "t"
            }
        );
        expect(plain.has("MODRINTH_PROJECTS")).toBe(false);
    });
});

describe("on a NeoForge server, through the Polaris mod", () => {
    const MOD = `${BASE}/api/minecraft/mod/polaris-neoforge-1.21.4.jar`;
    const neo = (extra: [string, string][] = []) =>
        new Map<string, string>([["TYPE", "NEOFORGE"], ["VERSION", "1.21.4"], ...extra]);

    it("counts as protected, and is wanted by default, only where the mod has a build", () => {
        expect(anticheat.anticheatBuildFor("NEOFORGE", "1.21.4")).toEqual({
            kind: "mod",
            file: "polaris-neoforge-1.21.4.jar"
        });
        expect(anticheat.anticheatBuildFor("NEOFORGE", "1.20.1")).toBeNull();
        expect(anticheat.anticheatBuildFor("FABRIC", "1.21.4")).toBeNull();
        expect(anticheat.wantsDefaultAnticheat(neo())).toBe(true);
        expect(anticheat.wantsDefaultAnticheat(neo([["POLARIS_ANTICHEAT", "off"]]))).toBe(false);
    });

    it("is on already where the login put the mod there, and off once switched off", () => {
        const offgrid = neo([
            ["MODS", MOD],
            ["POLARIS_LOGIN", "on"]
        ]);
        expect(anticheat.anticheatActive(offgrid)).toBe(true);
        expect(anticheat.anticheatActive(neo())).toBe(false);
        const off = anticheat.anticheatDisableEnv(offgrid);
        // The login still needs the mod; it is only told to stop hiding ore.
        expect(off.get("MODS")).toBe(MOD);
        expect(off.get("POLARIS_ANTIXRAY")).toBe("off");
        expect(anticheat.anticheatActive(new Map([...offgrid, ...off]))).toBe(false);
    });

    it("puts the mod on the list when turned on, and takes it off again without the login", () => {
        const on = anticheat.anticheatEnableEnv(neo([["POLARIS_ANTIXRAY", "off"]]), {
            baseUrl: BASE,
            installedAppId: SERVER,
            token: "t"
        });
        expect(on.get("MODS")).toBe(MOD);
        expect(on.get("POLARIS_ANTICHEAT")).toBe("on");
        expect(on.get("POLARIS_ANTIXRAY")).toBe("");
        const env = new Map([...neo(), ...on]);
        expect(anticheat.anticheatActive(env)).toBe(true);
        expect(anticheat.anticheatOn(env)).toBe(true);
        expect(anticheat.anticheatDisableEnv(env).get("MODS")).toBe("");
    });

    const guarded = () =>
        neo([
            ["MODS", MOD],
            ["POLARIS_ANTICHEAT", "on"]
        ]);
    const saved = async (vars: { key: string; value: string }[], env: Map<string, string>) =>
        new Map((await guardForSave(vars, async () => env)).map((one) => [one.key, one.value]));

    it("takes the mod off a release it has no build for, on a save of the release alone", async () => {
        const writes = await saved([{ key: "VERSION", value: "1.21.1" }], guarded());
        expect(writes.get("MODS")).toBe("");
        expect(writes.get("POLARIS_ANTICHEAT")).toBe("");
    });

    it("hands a move to Paper back to the default, which gives it the plugin", async () => {
        const writes = await saved([{ key: "TYPE", value: "PAPER" }], guarded());
        expect(writes.get("MODS")).toBe("");
        expect(writes.get("POLARIS_ANTICHEAT")).toBe("");
        const moved = new Map([...guarded(), ...writes, ["TYPE", "PAPER"]]);
        expect(anticheat.wantsDefaultAnticheat(moved)).toBe(true);
    });

    it("judges the build by where the server was, not where it is going", () => {
        const writes = anticheat.anticheatMovedTo(guarded(), "NEOFORGE", "1.21.1");
        expect(writes?.get("MODS")).toBe("");
        expect(anticheat.anticheatMovedTo(guarded(), "NEOFORGE", "1.21.4")).toBeNull();
    });

    it("keeps the mod on the list for the login, which moves it itself", () => {
        const both = new Map([...guarded(), ["POLARIS_LOGIN", "on"]]);
        expect(anticheat.anticheatMovedTo(both, "FABRIC", "1.21.4")?.get("MODS")).toBe(MOD);
    });

    it("is not carried by a template", () => {
        const extra = "https://example.org/extra.jar";
        const env = neo([
            ["MODS", `${extra},${MOD}`],
            ["POLARIS_ANTICHEAT", "on"]
        ]);
        expect(guardAsTemplate(env).get("MODS")).toBe(extra);
    });

    it("holds the mod against the login switching off only while switched on", () => {
        expect(anticheat.anticheatHoldsMod(guarded())).toBe(true);
        expect(anticheat.anticheatHoldsMod(neo([["MODS", MOD]]))).toBe(false);
        expect(
            anticheat.anticheatHoldsMod(new Map([...guarded(), ["POLARIS_ANTICHEAT", "off"]]))
        ).toBe(false);
    });
});
