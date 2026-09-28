/**
 * What a server has to carry for Polaris's anti-cheat engine, and where it may.
 *
 * What is pinned: it runs on Paper and the servers built on it, Folia and Spigot,
 * and nowhere a mod loader changes how players move; switching it on puts one
 * entry on `MODS` beside everything else there - the login's jar included - and
 * off takes only that entry away, writing the list even when that empties it; a
 * settings save that moves the server to software it cannot run on takes it off,
 * without disturbing what the login's own rules write; and the image builds and
 * serves the file.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { guardForSave } from "@polaris-app/game-servers/src/lib/minecraft/join-guard";
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
        expect(writes.get("POLARIS_ANTICHEAT")).toBe("off");
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
