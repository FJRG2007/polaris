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
const JAR = `${BASE}/api/minecraft/mod/key/polaris-anticheat-bukkit.jar`;
const LOGIN = `${BASE}/api/minecraft/mod/key/polaris-paper.jar`;
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
        const input = {
            baseUrl: `${BASE}/`,
            modKey: "key",
            installedAppId: SERVER,
            token: "secret"
        };
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
            dockerfile.indexOf("node packages/app-host/bundler/build.mjs /build/app-bundles")
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
            { baseUrl: BASE, modKey: "key", installedAppId: SERVER, token: "t" }
        );
        expect(on.get("MODRINTH_PROJECTS")).toBe("coreprotect?");
        // A list that had nothing to take off is not written at all.
        const plain = anticheat.anticheatEnableEnv(
            new Map([["MODRINTH_PROJECTS", "coreprotect?"]]),
            {
                baseUrl: BASE,
                modKey: "key",
                installedAppId: SERVER,
                token: "t"
            }
        );
        expect(plain.has("MODRINTH_PROJECTS")).toBe(false);
    });
});

describe("on a NeoForge server, through the Polaris mod", () => {
    const MOD = `${BASE}/api/minecraft/mod/key/polaris-neoforge-1.21.4.jar`;
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
        const examplesmp = neo([
            ["MODS", MOD],
            ["POLARIS_LOGIN", "on"]
        ]);
        expect(anticheat.anticheatActive(examplesmp)).toBe(true);
        expect(anticheat.anticheatActive(neo())).toBe(false);
        const off = anticheat.anticheatDisableEnv(examplesmp);
        // The login still needs the mod; it is only told to stop hiding ore.
        // The mod is the server's Polaris component: it stays on the list.
        expect(off.has("MODS")).toBe(false);
        expect(off.get("POLARIS_ANTIXRAY")).toBe("off");
        expect(anticheat.anticheatActive(new Map([...examplesmp, ...off]))).toBe(false);
    });

    it("puts the mod on the list when turned on, and keeps it there when turned off", () => {
        const on = anticheat.anticheatEnableEnv(neo([["POLARIS_ANTIXRAY", "off"]]), {
            baseUrl: BASE,
            modKey: "key",
            installedAppId: SERVER,
            token: "t"
        });
        expect(on.get("MODS")).toBe(MOD);
        expect(on.get("POLARIS_ANTICHEAT")).toBe("on");
        expect(on.get("POLARIS_ANTIXRAY")).toBe("");
        const env = new Map([...neo(), ...on]);
        expect(anticheat.anticheatActive(env)).toBe(true);
        expect(anticheat.anticheatOn(env)).toBe(true);
        expect(anticheat.anticheatDisableEnv(env).has("MODS")).toBe(false);
        expect(anticheat.anticheatDisableEnv(env).get("POLARIS_ANTIXRAY")).toBe("off");
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

describe("on a Forge server, through the engine's own mod", () => {
    const ENGINE = `${BASE}/api/minecraft/mod/key/polaris-anticheat-forge-1.20.1.jar`;
    const forge = (extra: [string, string][] = []) =>
        new Map<string, string>([["TYPE", "FORGE"], ["VERSION", "1.20.1"], ...extra]);
    const input = { baseUrl: BASE, modKey: "key", installedAppId: SERVER, token: "t" };

    it("has a build for 1.20.1 alone, and is wanted by default there", () => {
        expect(anticheat.anticheatBuildFor("FORGE", "1.20.1")).toEqual({
            kind: "engine",
            file: "polaris-anticheat-forge-1.20.1.jar"
        });
        expect(anticheat.anticheatBuildFor("FORGE", "1.21.1")).toBeNull();
        expect(anticheat.anticheatBuildFor("FORGE", "")).toBeNull();
        expect(anticheat.wantsDefaultAnticheat(forge())).toBe(true);
        expect(anticheat.wantsDefaultAnticheat(forge([["POLARIS_ANTICHEAT", "off"]]))).toBe(false);
        expect(anticheat.ANTICHEAT_FILES).toContain("polaris-anticheat-forge-1.20.1.jar");
    });

    it("goes on the list like the plugin, and comes off it when switched off", () => {
        const other = "https://elsewhere.example/other.jar";
        const on = anticheat.anticheatEnableEnv(forge([["MODS", other]]), input);
        expect(on.get("MODS")).toBe(`${other},${ENGINE}`);
        expect(on.get("POLARIS_ANTICHEAT")).toBe("on");
        // It has no anti-xray of its own to switch.
        expect(on.has("POLARIS_ANTIXRAY")).toBe(false);
        const env = new Map([...forge(), ...on]);
        expect(anticheat.anticheatOn(env)).toBe(true);
        expect(anticheat.anticheatActive(env)).toBe(true);
        expect(anticheat.anticheatHoldsMod(env)).toBe(false);
        const off = anticheat.anticheatDisableEnv(env);
        expect(off.get("MODS")).toBe(other);
        expect(off.get("POLARIS_ANTICHEAT")).toBe("off");
        expect(anticheat.anticheatActive(new Map([...env, ...off]))).toBe(false);
    });

    it("is not on with the switch alone, nor with the jar alone", () => {
        expect(anticheat.anticheatActive(forge([["POLARIS_ANTICHEAT", "on"]]))).toBe(false);
        expect(anticheat.anticheatActive(forge([["MODS", ENGINE]]))).toBe(false);
    });

    it("comes off a release or software its jar does not load on", async () => {
        const guarded = forge([
            ["MODS", ENGINE],
            ["POLARIS_ANTICHEAT", "on"]
        ]);
        expect(anticheat.anticheatMovedTo(guarded, "FORGE", "1.21.1")?.get("MODS")).toBe("");
        expect(anticheat.anticheatMovedTo(guarded, "FORGE", "1.20.1")).toBeNull();
        const writes = new Map(
            (
                await guardForSave([{ key: "TYPE", value: "PAPER" }], async () => guarded)
            ).map((one) => [one.key, one.value])
        );
        expect(writes.get("MODS")).toBe("");
        expect(writes.get("POLARIS_ANTICHEAT")).toBe("");
        expect(anticheat.withoutAnticheatBuild(guarded)).toBe("");
        expect(guardAsTemplate(guarded).get("MODS")).toBe("");
    });
});

describe("the plugin on an old Java", () => {
    const plugin = "https://polaris.example.com/api/minecraft/mods/polaris-anticheat-bukkit.jar";

    it("is not offered where the managed image carries Java 8 or 11", () => {
        expect(anticheat.anticheatBuildFor("PAPER", "1.16.5")).toBeNull();
        expect(anticheat.anticheatBuildFor("PAPER", "1.8.8")).toBeNull();
        expect(anticheat.anticheatBuildFor("PAPER", "1.17.1")?.kind).toBe("plugin");
        expect(anticheat.anticheatBuildFor("PAPER", "LATEST")?.kind).toBe("plugin");
    });

    it("comes off a server that got it before, and only there", () => {
        expect(anticheat.unfitAnticheatRemoved(`a.jar,${plugin}`, "PAPER", "1.16.5")).toBe("a.jar");
        expect(anticheat.unfitAnticheatRemoved(`a.jar,${plugin}`, "PAPER", "1.21.4")).toBeNull();
        expect(anticheat.unfitAnticheatRemoved("a.jar", "PAPER", "1.16.5")).toBeNull();
        expect(anticheat.unfitAnticheatRemoved(plugin, "FABRIC", "1.16.5")).toBeNull();
    });
});

describe("the game's flight check", () => {
    const input = { baseUrl: "https://polaris.example", modKey: "k", installedAppId: "app", token: "t" };
    const paper = (extra: [string, string][] = []) =>
        new Map<string, string>([["TYPE", "PAPER"], ["VERSION", "1.21.4"], ...extra]);

    it("goes to the engine when it is switched on, since it catches flying itself", () => {
        const on = anticheat.anticheatEnableEnv(paper(), input);
        expect(on.get("ALLOW_FLIGHT")).toBe("true");
        expect(on.get("POLARIS_FLIGHT")).toBe("anticheat");
    });

    it("leaves a value the owner set alone", () => {
        const on = anticheat.anticheatEnableEnv(paper([["ALLOW_FLIGHT", "false"]]), input);
        expect(on.has("ALLOW_FLIGHT")).toBe(false);
    });

    it("comes back when the engine is switched off, only if Polaris took it", () => {
        const off = anticheat.anticheatDisableEnv(
            paper([["ALLOW_FLIGHT", "true"], ["POLARIS_FLIGHT", "anticheat"]])
        );
        expect(off.get("ALLOW_FLIGHT")).toBe("false");
        expect(off.get("POLARIS_FLIGHT")).toBe("vanilla");
        expect(anticheat.anticheatDisableEnv(paper([["ALLOW_FLIGHT", "true"]])).has("ALLOW_FLIGHT")).toBe(false);
        // Switched on again, it is handed over again.
        expect(
            anticheat.anticheatEnableEnv(paper([["ALLOW_FLIGHT", "false"], ["POLARIS_FLIGHT", "vanilla"]]), input).get(
                "ALLOW_FLIGHT"
            )
        ).toBe("true");
    });

    it("is handed over on servers protected before, and nowhere the engine does not run", () => {
        const protectedBefore = anticheat.anticheatEnableEnv(paper(), input);
        protectedBefore.delete("ALLOW_FLIGHT");
        protectedBefore.delete("POLARIS_FLIGHT");
        const env = new Map([...paper(), ...protectedBefore]);
        expect(anticheat.flightHandover(env)?.get("ALLOW_FLIGHT")).toBe("true");
        expect(anticheat.flightHandover(new Map([...env, ["POLARIS_FLIGHT", "anticheat"]]))).toBeNull();
        // Forge: no engine, so the game's own check stays as the owner has it.
        expect(anticheat.flightHandover(new Map([["TYPE", "FORGE"], ["VERSION", "1.20.1"]]))).toBeNull();
    });
});
