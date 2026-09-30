/**
 * Mods that announce themselves on every join, and the one value in their config
 * that stops it.
 *
 * What is pinned: the edit changes that value's characters and nothing else -
 * comments, spacing, order and every other value survive, CRLF files stay CRLF -
 * and it follows the file as TOML, so a line inside a multi-line string or array
 * is never taken for the setting; a key that is missing is added to its own
 * table; a file it cannot follow, or a key only reachable through an inline
 * table, is refused rather than guessed at. And the registry: the jar is found by
 * its file name, the config is looked for where NeoForge reads it (and in the
 * world's override folder), and the operator's choice decides the value.
 */

import { describe, expect, it } from "vitest";
import {
    TomlShapeError,
    readTomlValue,
    setTomlValue
} from "@polaris-app/game-servers/src/lib/minecraft/toml-edit";
import * as announcements from "@polaris-app/game-servers/src/lib/minecraft/mod-announcements";

/** The shape NeoForge's config writer gives a SERVER config: comments above each
 *  key, lists inline, everything at the top level. */
const SECURITYCRAFT = [
    "#Set this to true to enable every player on a scoreboard team (or FTB Teams party) to own the blocks of every other player on the same team.",
    "enable_team_ownership = false",
    '#This list defines in which order SecurityCraft checks teams of players ["like this"].',
    'team_ownership_precedence = ["FTB_TEAMS", "VANILLA"]',
    "#Set this to true to disable sending the message that SecurityCraft shows when a player joins.",
    "#Note, that this stops showing the message for every player, even those that want to see them.",
    "disable_thanks_message = false",
    "#Set this to true if you want players wearing a different player's skull to be able to trick their retinal scanners.",
    "trick_scanners_with_player_heads = false",
    ""
].join("\n");

describe("one value in a TOML file", () => {
    it("changes only that value", () => {
        const next = setTomlValue(SECURITYCRAFT, [], "disable_thanks_message", "true");
        expect(next.changed).toBe(true);
        expect(next.text).toBe(
            SECURITYCRAFT.replace("disable_thanks_message = false", "disable_thanks_message = true")
        );
        expect(readTomlValue(next.text, [], "disable_thanks_message")).toBe("true");
    });

    it("writes nothing when the value is already there", () => {
        const once = setTomlValue(SECURITYCRAFT, [], "disable_thanks_message", "true").text;
        expect(setTomlValue(once, [], "disable_thanks_message", "true")).toEqual({
            text: once,
            changed: false
        });
    });

    it("keeps a comment after the value and the spacing around it", () => {
        const text = "a = 1\n  flag   =   false   # keep me\nb = 2\n";
        expect(setTomlValue(text, [], "flag", "true").text).toBe(
            "a = 1\n  flag   =   true   # keep me\nb = 2\n"
        );
    });

    it("keeps Windows line endings", () => {
        const text = "#c\r\nflag = false\r\nother = 1\r\n";
        expect(setTomlValue(text, [], "flag", "true").text).toBe("#c\r\nflag = true\r\nother = 1\r\n");
        expect(setTomlValue(text, [], "added", "true").text).toBe(
            "#c\r\nflag = false\r\nother = 1\r\nadded = true\r\n"
        );
    });

    it("finds a key in its table, not the same name in another", () => {
        const text = "[client]\nflag = false\n\n[server]\n# the one\nflag = false\n";
        const next = setTomlValue(text, ["server"], "flag", "true").text;
        expect(next).toBe("[client]\nflag = false\n\n[server]\n# the one\nflag = true\n");
        expect(readTomlValue(next, ["client"], "flag")).toBe("false");
    });

    it("follows dotted and quoted keys", () => {
        expect(readTomlValue("server.flag = false\n", ["server"], "flag")).toBe("false");
        expect(readTomlValue('[server]\n"flag" = true\n', ["server"], "flag")).toBe("true");
        expect(readTomlValue("[a.b]\nflag = 1\n", ["a", "b"], "flag")).toBe("1");
    });

    it("never takes a line inside a multi-line string or array for the setting", () => {
        const text = [
            'notes = """',
            "flag = false",
            '"""',
            "list = [",
            '    "flag = false", # flag = false',
            "    'x',",
            "]",
            "flag = false",
            ""
        ].join("\n");
        const next = setTomlValue(text, [], "flag", "true").text;
        expect(next).toBe(text.replace(/flag = false\n$/, "flag = true\n"));
        expect(next.split("flag = false").length - 1).toBe(3);
    });

    it("adds a missing key at the end of its table", () => {
        expect(setTomlValue("[server]\na = 1\n\n[other]\nb = 2\n", ["server"], "flag", "true").text).toBe(
            "[server]\na = 1\nflag = true\n\n[other]\nb = 2\n"
        );
        expect(setTomlValue("[server]\n", ["server"], "flag", "true").text).toBe(
            "[server]\nflag = true\n"
        );
    });

    it("adds a missing top-level key before the first table", () => {
        expect(setTomlValue("[server]\na = 1\n", [], "flag", "true").text).toBe(
            "flag = true\n[server]\na = 1\n"
        );
        expect(setTomlValue("x = 1\n[server]\n", [], "flag", "true").text).toBe(
            "x = 1\nflag = true\n[server]\n"
        );
    });

    it("adds a missing table at the end", () => {
        expect(setTomlValue("a = 1", ["server"], "flag", "true").text).toBe(
            "a = 1\n\n[server]\nflag = true\n"
        );
        expect(setTomlValue("", ["server"], "flag", "true").text).toBe("[server]\nflag = true\n");
    });

    it("reads and writes keys and tables that need quotes", () => {
        const text = `[Gameplay]\n"Show Patreon message" = true\n`;
        expect(setTomlValue(text, ["Gameplay"], "Show Patreon message", "false").text).toBe(
            `[Gameplay]\n"Show Patreon message" = false\n`
        );
        expect(
            setTomlValue("", ["world settings"], "version message (true/false)", "false").text
        ).toBe(`["world settings"]\n"version message (true/false)" = false\n`);
    });

    it("refuses a key only reachable through an inline table", () => {
        expect(() => setTomlValue("server = { a = 1 }\n", ["server"], "flag", "true")).toThrow(
            TomlShapeError
        );
    });

    it("refuses a file it cannot follow", () => {
        expect(() => setTomlValue('flag = "open\n', [], "flag", "true")).toThrow(TomlShapeError);
        expect(() => setTomlValue("flag = [1, 2\n", [], "flag", "true")).toThrow(TomlShapeError);
        expect(() => setTomlValue("flag false\n", [], "flag", "true")).toThrow(TomlShapeError);
        expect(() => setTomlValue("flag = 1 2\n", [], "flag", "true")).toThrow(TomlShapeError);
    });
});

describe("mods that announce themselves", () => {
    const securitycraft = announcements.ANNOUNCERS.find((one) => one.id === "securitycraft")!;

    it("knows SecurityCraft's thanks message and the key that stops it", () => {
        expect(securitycraft).toMatchObject({
            file: "securitycraft-server.toml",
            table: [],
            key: "disable_thanks_message",
            blocked: "true",
            allowed: "false",
            applies: "join"
        });
    });

    it("finds the jar by its file name", () => {
        expect(
            announcements
                .installedAnnouncers(["[1.21.4] SecurityCraft v1.10.1.jar", "other.jar"])
                .map((one) => one.id)
        ).toEqual(["securitycraft"]);
        expect(announcements.installedAnnouncers(["securitycraft.txt", "create.jar"])).toEqual([]);
    });

    it("tells apart mods whose names overlap", () => {
        const ids = (files: string[]) => announcements.installedAnnouncers(files).map((one) => one.id);
        expect(ids(["aether-1.21.1-1.5.2-neoforge.jar"])).toEqual(["aether"]);
        expect(ids(["aether_ii-26.1-0.1.jar"])).toEqual(["aether_ii"]);
        expect(ids(["deep_aether-1.21.1.jar"])).toEqual([]);
        expect(ids(["vampirism-1.21-1.10.jar", "vampirism-integrations-1.21.jar"])).toEqual([
            "vampirism"
        ]);
        expect(ids(["vampirism-integrations-1.21.jar"])).toEqual([]);
    });

    it("sources every entry and writes only what the mod reads", () => {
        for (const one of announcements.ANNOUNCERS) {
            expect(one.source).toMatch(/^https:\/\/github\.com\//);
            expect(one.blocked).not.toBe(one.allowed);
            expect(["true", "false"]).toContain(one.blocked);
            expect(one.file).toMatch(/^[A-Za-z0-9_./-]+\.toml$/);
        }
        expect(new Set(announcements.ANNOUNCERS.map((one) => one.id)).size).toBe(
            announcements.ANNOUNCERS.length
        );
    });

    it("looks for the config in config/ and in the world's own override", () => {
        expect(announcements.configPaths(securitycraft, "/data", "world")).toEqual([
            "/data/config/securitycraft-server.toml",
            "/data/world/serverconfig/securitycraft-server.toml"
        ]);
    });

    it("blocks by default and lets through what the operator allowed", () => {
        const none = announcements.readAnnouncementChoices({});
        expect(announcements.wantedValue(securitycraft, none)).toBe("true");
        const allowed = announcements.withChoice(none, "securitycraft", true);
        expect(announcements.wantedValue(securitycraft, allowed)).toBe("false");
        expect(announcements.withChoice(allowed, "securitycraft", false).allowed).toEqual([]);
    });

    it("reads stored choices totally, dropping what it does not know", () => {
        expect(
            announcements.readAnnouncementChoices({
                [announcements.ANNOUNCEMENTS_KEY]: { allowed: ["securitycraft", "gone"] }
            })
        ).toEqual({ allowed: ["securitycraft"] });
        expect(
            announcements.readAnnouncementChoices({ [announcements.ANNOUNCEMENTS_KEY]: "junk" })
        ).toEqual({ allowed: [] });
    });

    it("blocks SecurityCraft's message in a real-shaped file", () => {
        const wanted = announcements.wantedValue(securitycraft, { allowed: [] });
        const next = setTomlValue(SECURITYCRAFT, securitycraft.table, securitycraft.key, wanted);
        expect(readTomlValue(next.text, [], "disable_thanks_message")).toBe("true");
        expect(readTomlValue(next.text, [], "team_ownership_precedence")).toBe(
            '["FTB_TEAMS", "VANILLA"]'
        );
    });
});
