import { describe, expect, it } from "vitest";
import {
    ARK_SETTINGS,
    arkSettingGroups,
    findArkSetting,
    normalizeArkValue,
    parseArkOverrides,
    parseIniSection,
    RECOMMENDED_ARK_SETTINGS,
    writeArkOverrides
} from "@/lib/apps/ark/settings";

/** What the image's own template leaves in the file. None of it is this screen's. */
const IMAGE_CONFIG = [
    'arkserverroot="${ARK_SERVER_VOLUME}/server"',
    "ark_SessionName=${SESSION_NAME}",
    "ark_ServerPassword=${SERVER_PASSWORD}",
    "ark_MaxPlayers=${MAX_PLAYERS}",
    "ark_GameModIds=${GAME_MOD_IDS}"
].join("\n");

const setting = (key: string) => {
    const found = findArkSetting(key);
    if (!found) throw new Error(`no such setting: ${key}`);
    return found;
};

describe("the catalogue", () => {
    it("has no two settings under one key", () => {
        const keys = ARK_SETTINGS.map((entry) => entry.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("names every setting the way the game spells it, with nothing a query string would break on", () => {
        for (const entry of ARK_SETTINGS) expect(entry.key).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    });

    it("groups every setting, in the order they are declared", () => {
        expect(arkSettingGroups().flatMap((group) => group.settings)).toHaveLength(ARK_SETTINGS.length);
    });

    it("only recommends settings it can actually write", () => {
        for (const [key, value] of Object.entries(RECOMMENDED_ARK_SETTINGS)) {
            const found = findArkSetting(key);
            expect(found).toBeDefined();
            expect(normalizeArkValue(found as never, value)).toBe(value);
        }
    });
});

describe("normalizeArkValue", () => {
    it("writes a switch the way the game writes it", () => {
        expect(normalizeArkValue(setting("ServerPVE"), "true")).toBe("True");
        expect(normalizeArkValue(setting("ServerPVE"), "False")).toBe("False");
    });

    it("refuses a word where a number belongs", () => {
        expect(normalizeArkValue(setting("XPMultiplier"), "True")).toBeNull();
    });

    it("keeps a multiplier exactly as it was typed", () => {
        // 1.50 and 1.5 are the same setting; rewriting somebody's number is a diff
        // nobody asked for.
        expect(normalizeArkValue(setting("XPMultiplier"), "1.50")).toBe("1.50");
        expect(normalizeArkValue(setting("XPMultiplier"), " 3 ")).toBe("3");
    });

    it("refuses a fraction where the game takes whole seconds", () => {
        expect(normalizeArkValue(setting("KickIdlePlayersPeriod"), "60.5")).toBeNull();
        expect(normalizeArkValue(setting("KickIdlePlayersPeriod"), "600")).toBe("600");
    });

    it("holds a value to its range", () => {
        expect(normalizeArkValue(setting("DifficultyOffset"), "0.5")).toBe("0.5");
        expect(normalizeArkValue(setting("DifficultyOffset"), "5")).toBeNull();
    });

    it("refuses anything that would carry a second option into the command line", () => {
        expect(normalizeArkValue(setting("XPMultiplier"), "3?ServerPVE=True")).toBeNull();
        expect(normalizeArkValue(setting("ServerPVE"), "True?Cheat")).toBeNull();
    });
});

describe("parseArkOverrides", () => {
    it("reads only the settings this screen owns", () => {
        const config = `${IMAGE_CONFIG}\nark_XPMultiplier=3\nark_ServerPVE=True`;
        expect(parseArkOverrides(config)).toEqual({ XPMultiplier: "3", ServerPVE: "True" });
    });

    it("takes the quotes off a value, since the file is read by a shell", () => {
        expect(parseArkOverrides('ark_XPMultiplier="2.5"')).toEqual({ XPMultiplier: "2.5" });
    });

    it("ignores a commented-out line", () => {
        expect(parseArkOverrides("# ark_XPMultiplier=9")).toEqual({});
    });

    it("reads nothing out of a file that has none", () => {
        expect(parseArkOverrides(IMAGE_CONFIG)).toEqual({});
    });
});

describe("writeArkOverrides", () => {
    it("leaves every line that is not one of ours exactly as it was", () => {
        const written = writeArkOverrides(IMAGE_CONFIG, { XPMultiplier: "3" });
        for (const line of IMAGE_CONFIG.split("\n")) expect(written).toContain(line);
        expect(written).toContain("ark_XPMultiplier=3");
    });

    it("rewrites a setting where it already sits", () => {
        const before = `ark_XPMultiplier=3\nark_MaxPlayers=\${MAX_PLAYERS}\nark_ServerPVE=True`;
        const written = writeArkOverrides(before, { XPMultiplier: "5", ServerPVE: "True" });
        expect(written.split("\n").filter((line) => line.startsWith("ark_XPMultiplier"))).toEqual([
            "ark_XPMultiplier=5"
        ]);
        // And in the same place, so a file somebody reads does not reshuffle.
        expect(written.indexOf("ark_XPMultiplier")).toBeLessThan(written.indexOf("ark_MaxPlayers"));
    });

    it("drops a setting that is no longer pinned", () => {
        const written = writeArkOverrides("ark_XPMultiplier=3\nark_ServerPVE=True", { ServerPVE: "True" });
        expect(written).not.toContain("XPMultiplier");
        expect(written).toContain("ark_ServerPVE=True");
    });

    it("appends a new one under a heading that says who wrote it", () => {
        const written = writeArkOverrides(IMAGE_CONFIG, { ServerCrosshair: "True" });
        expect(written).toContain("managed by Polaris");
        expect(written.trimEnd().endsWith("ark_ServerCrosshair=True")).toBe(true);
    });

    it("does not grow a blank line on every save", () => {
        const blanks = (text: string) => text.split("\n").filter((line) => line.trim().length === 0).length;
        const once = writeArkOverrides(IMAGE_CONFIG, { XPMultiplier: "1" });
        let config = once;
        for (let round = 1; round < 5; round += 1) {
            config = writeArkOverrides(config, { XPMultiplier: String(round + 1) });
        }
        expect(blanks(config)).toBe(blanks(once));
        expect(parseArkOverrides(config)).toEqual({ XPMultiplier: "5" });
    });

    it("round-trips", () => {
        const overrides = { XPMultiplier: "3", ServerPVE: "True", ShowMapPlayerLocation: "True" };
        expect(parseArkOverrides(writeArkOverrides(IMAGE_CONFIG, overrides))).toEqual(overrides);
    });

    it("ends the file with exactly one newline, so a shell reads the last line", () => {
        const written = writeArkOverrides(IMAGE_CONFIG, { XPMultiplier: "3" });
        expect(written.endsWith("\n")).toBe(true);
        expect(written.endsWith("\n\n")).toBe(false);
    });
});

describe("parseIniSection", () => {
    const ini = [
        "[/Script/Engine.GameSession]",
        "MaxPlayers=20",
        "[ServerSettings]",
        "; a comment",
        "XPMultiplier=3.000000",
        "ServerPVE=True",
        "",
        "[SessionSettings]",
        "SessionName=Somewhere"
    ].join("\r\n");

    it("reads the values of one section and nothing else", () => {
        expect(parseIniSection(ini, "ServerSettings")).toEqual({
            XPMultiplier: "3.000000",
            ServerPVE: "True"
        });
    });

    it("does not care how the heading is cased", () => {
        expect(parseIniSection(ini, "serversettings").ServerPVE).toBe("True");
    });

    it("reads nothing out of a file without that section", () => {
        expect(parseIniSection(ini, "ShooterGameMode")).toEqual({});
    });
});
