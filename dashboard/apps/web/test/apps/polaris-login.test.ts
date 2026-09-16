/**
 * What a server has to carry for Polaris's login mod, and when it may.
 *
 * The two ways this goes wrong are both silent. A jar for the wrong release is a
 * server the loader refuses to start, and a `MODS` list that drops the jar
 * without being written at all leaves the jar in the mods folder - the image only
 * removes what a list it was given no longer names.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as login from "@/lib/apps/minecraft/polaris-login";

const BASE = "https://polaris.example";
const JAR = "polaris-neoforge-1.21.4.jar";
const URL = `${BASE}/api/minecraft/mod/${JAR}`;

describe("which servers have a build", () => {
    it("is NeoForge on the release the jar was built for", () => {
        expect(login.modFileFor("NEOFORGE", "1.21.4")).toBe(JAR);
        expect(login.modFileFor("neoforge", " 1.21.4 ")).toBe(JAR);
    });

    it("is nothing else", () => {
        expect(login.modFileFor("NEOFORGE", "1.21.1")).toBeNull();
        expect(login.modFileFor("NEOFORGE", "LATEST")).toBeNull();
        expect(login.modFileFor("FABRIC", "1.21.4")).toBeNull();
        expect(login.modFileFor("PAPER", "1.21.4")).toBeNull();
        expect(login.modFileFor("VANILLA", "1.21.4")).toBeNull();
    });

    it("is every file the image builds", () => {
        // The route serves only these names and the image has to produce each one,
        // or a server switched on downloads a 404 and does not start.
        const dockerfile = readFileSync(
            join(__dirname, "..", "..", "..", "..", "docker", "Dockerfile"),
            "utf8"
        );
        for (const file of login.MOD_FILES) expect(dockerfile).toContain(`/out/${file}`);
    });
});

describe("the MODS list", () => {
    it("gains exactly one build, keeping what else is there", () => {
        const mods = login.withMod("https://example.org/other.jar", URL);
        expect(mods).toBe(`https://example.org/other.jar,${URL}`);
        expect(login.withMod(mods, URL)).toBe(mods);
    });

    it("recognises a build written with another address", () => {
        expect(
            login.hasMod("http://10.0.0.2:3000/api/minecraft/mod/polaris-neoforge-1.21.4.jar")
        ).toBe(true);
        expect(login.hasMod("https://example.org/polaris-helper.jar")).toBe(false);
        expect(login.hasMod("")).toBe(false);
    });

    it("loses it to an empty value rather than to nothing", () => {
        expect(login.withoutMod(URL)).toBe("");
        expect(login.withoutMod(`a.jar\n${URL}`)).toBe("a.jar");
    });
});

describe("switching it", () => {
    const current = new Map([
        ["MODS", "https://example.org/other.jar"],
        ["MODRINTH_PROJECTS", "auth?"]
    ]);

    it("writes the jar, the switch, the address, the id and the token", () => {
        const env = login.enableEnv({
            current,
            baseUrl: `${BASE}/`,
            installedAppId: "0190c0de-0000-7000-8000-000000000001",
            file: JAR,
            token: "secret"
        });
        expect(env.get("MODS")).toBe(`https://example.org/other.jar,${URL}`);
        expect(env.get("POLARIS_LOGIN")).toBe("on");
        expect(env.get("POLARIS_URL")).toBe(BASE);
        expect(env.get("POLARIS_SERVER_ID")).toBe("0190c0de-0000-7000-8000-000000000001");
        expect(env.get("POLARIS_SERVER_TOKEN")).toBe("secret");
        // The project list is join-guard's to write.
        expect(env.has("MODRINTH_PROJECTS")).toBe(false);
        expect(login.loginOn(new Map([...current, ...env]))).toBe(true);
    });

    it("takes the jar off and the switch down", () => {
        const on = new Map([...current, ["MODS", `a.jar,${URL}`], ["POLARIS_LOGIN", "on"]]);
        const env = login.disableEnv(on);
        expect(env.get("MODS")).toBe("a.jar");
        expect(env.get("POLARIS_LOGIN")).toBe("off");
        expect(login.loginOn(new Map([...on, ...env]))).toBe(false);
    });

    it("is off with the switch alone, or the jar alone", () => {
        expect(login.loginOn(new Map([["POLARIS_LOGIN", "on"]]))).toBe(false);
        expect(login.loginOn(new Map([["MODS", URL]]))).toBe(false);
    });
});

describe("moving a server that runs it", () => {
    const on = new Map([
        ["MODS", URL],
        ["POLARIS_LOGIN", "on"]
    ]);

    it("does nothing where the build it names still fits", () => {
        expect(login.modMovedTo(on, "NEOFORGE", "1.21.4")).toBeNull();
    });

    it("does nothing to a server that does not run it", () => {
        expect(login.modMovedTo(new Map(), "PAPER", "1.21.4")).toBeNull();
    });

    it("takes it off where there is no build", () => {
        for (const [software, version] of [
            ["NEOFORGE", "1.21.1"],
            ["NEOFORGE", "LATEST"],
            ["PAPER", "1.21.4"]
        ] as const) {
            const env = login.modMovedTo(on, software, version);
            expect(env?.get("POLARIS_LOGIN"), `${software} ${version}`).toBe("off");
            expect(env?.get("MODS")).toBe("");
        }
    });

    it("points it at the right build when it names another one", () => {
        const stale = new Map([
            ...on,
            ["MODS", `${BASE}/api/minecraft/mod/polaris-neoforge-1.21.1.jar`]
        ]);
        expect(login.modMovedTo(stale, "NEOFORGE", "1.21.4")?.get("MODS")).toBe(URL);
    });

    it("takes it off when the build it names is not served from here", () => {
        const foreign = new Map([
            ...on,
            ["MODS", "https://mods.example/polaris-neoforge-1.21.1.jar"]
        ]);
        const env = login.modMovedTo(foreign, "NEOFORGE", "1.21.4");
        expect(env?.get("POLARIS_LOGIN")).toBe("off");
        expect(env?.get("MODS")).toBe("");
    });
});

describe("whether the panel should raise the alarm", () => {
    const now = new Date("2026-09-16T12:00:00Z");
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

    it("is fine after a recent check-in", () => {
        expect(login.loginHealth({ seenAt: ago(1), upSince: ago(60), now })).toBe("ok");
    });

    it("waits while the server is down or just started", () => {
        expect(login.loginHealth({ seenAt: null, upSince: null, now })).toBe("waiting");
        expect(login.loginHealth({ seenAt: ago(90), upSince: ago(1), now })).toBe("waiting");
    });

    it("is an outage when a server that has been up has not checked in", () => {
        expect(login.loginHealth({ seenAt: null, upSince: ago(10), now })).toBe("silent");
        expect(login.loginHealth({ seenAt: ago(5), upSince: ago(60), now })).toBe("silent");
    });
});

describe("what a player name may be", () => {
    it("takes what the game takes in offline mode", () => {
        for (const name of ["Steve", "a_b", "x", "sixteen_chars_ok", ".dot-name"]) {
            expect(login.PLAYER_NAME.test(name), name).toBe(true);
        }
    });

    it("refuses spaces, control characters and long names", () => {
        for (const name of ["", "two words", "tab\tname", "seventeen_chars_x", "ñandu"]) {
            expect(login.PLAYER_NAME.test(name), name).toBe(false);
        }
    });
});
