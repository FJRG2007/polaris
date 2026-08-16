/**
 * Reading a Minecraft server's answers.
 *
 * The panel's player count, moderation lists and whitelist switch are all read
 * out of text and files the server writes, and those differ between versions and
 * server flavours: vanilla and Paper word the `list` reply differently from
 * Bukkit, the console colours its own output, and the roster files do not exist
 * at all until someone is added to them. Each of those is a way for the panel to
 * show a confidently wrong answer - an empty server, an empty ban list, a
 * whitelist that reads as off - so they are pinned here against real output.
 */

import { describe, expect, it } from "vitest";
import * as parse from "@/lib/apps/minecraft/parse";

describe("parsePlayerList", () => {
    it("reads the modern reply, with names", () => {
        expect(parse.parsePlayerList("There are 2 of a max of 20 players online: Alice, Bob")).toEqual({
            online: 2,
            max: 20,
            players: ["Alice", "Bob"]
        });
    });

    it("reads an empty server without inventing a player", () => {
        expect(parse.parsePlayerList("There are 0 of a max of 20 players online: ")).toEqual({
            online: 0,
            max: 20,
            players: []
        });
    });

    it("reads the older Bukkit wording", () => {
        expect(parse.parsePlayerList("There are 1/20 players online:\nAlice")).toEqual({
            online: 1,
            max: 20,
            players: ["Alice"]
        });
    });

    it("sees through console colouring", () => {
        const coloured = "There are 1 of a max of 20 players online: §aAlice";
        expect(parse.parsePlayerList(coloured)?.players).toEqual(["Alice"]);
    });

    // A server still generating its world answers with nothing, or with an error
    // from rcon-cli. Reporting that as "0 players" would say the server is up and
    // empty, which is the one thing it is not.
    it("refuses anything that is not a player list", () => {
        expect(parse.parsePlayerList("")).toBeNull();
        expect(parse.parsePlayerList("Unknown command")).toBeNull();
    });
});

describe("parsePlayerListFromLog", () => {
    // Bedrock has no RCON: the command is written to the console and the answer is
    // only ever printed to the log, under whatever has happened since.
    it("takes the newest answer, not the first", () => {
        const log = [
            "[2026-08-07 22:24:35 INFO] There are 0/10 players online:",
            "[2026-08-07 22:30:01 INFO] Player connected: Alice",
            "[2026-08-07 22:31:00 INFO] There are 1/10 players online:",
            "Alice"
        ].join("\n");
        expect(parse.parsePlayerListFromLog(log)).toEqual({ online: 1, max: 10, players: ["Alice"] });
    });

    // The names are on the line below the count, and that line is a log line like
    // any other - so an empty server must not read the next entry as a player.
    it("does not read the following log line as a player when nobody is on", () => {
        const log = ["[INFO] There are 0/10 players online:", "[INFO] Server started."].join("\n");
        expect(parse.parsePlayerListFromLog(log)).toEqual({ online: 0, max: 10, players: [] });
    });

    it("has no answer in a log that never contained one", () => {
        expect(parse.parsePlayerListFromLog("[INFO] Server started.")).toBeNull();
    });
});

describe("parseBannedIps", () => {
    it("reads the addresses the server refuses", () => {
        const file = "[{\"ip\":\"203.0.113.7\",\"source\":\"Server\",\"reason\":\"Blocked\"}]";
        expect(parse.parseBannedIps(file)).toEqual(["203.0.113.7"]);
    });

    it("reads a server that has banned nobody", () => {
        expect(parse.parseBannedIps("")).toEqual([]);
    });
});

describe("parseWhitelistAnswer", () => {
    it("reads the whitelisted names", () => {
        expect(parse.parseWhitelistAnswer("There are 2 whitelisted players: Alice, Bob")).toEqual(["Alice", "Bob"]);
    });

    it("reads an empty whitelist", () => {
        expect(parse.parseWhitelistAnswer("There are no whitelisted players")).toEqual([]);
    });
});

describe("roster files", () => {
    it("reads ops and whitelist entries by name", () => {
        const ops = "[{\"uuid\":\"0-0-0-0-1\",\"name\":\"Alice\",\"level\":4,\"bypassesPlayerLimit\":false}]";
        expect(parse.parseNameFile(ops)).toEqual(["Alice"]);
    });

    // The files do not exist until the first op or ban, and `cat` on a missing
    // file gives back nothing at all.
    it("reads a missing file as an empty roster", () => {
        expect(parse.parseNameFile("")).toEqual([]);
        expect(parse.parseBansFile("")).toEqual([]);
    });

    it("keeps a ban's reason and who issued it", () => {
        const bans =
            "[{\"uuid\":\"0-0-0-0-2\",\"name\":\"Bob\",\"source\":\"Alice\",\"reason\":\"Griefing\",\"expires\":\"forever\"}]";
        expect(parse.parseBansFile(bans)).toEqual([{ name: "Bob", reason: "Griefing", source: "Alice" }]);
    });

    it("survives a file caught mid-write", () => {
        expect(parse.parseNameFile('[{"uuid":"0-0-0-0-1","na')).toEqual([]);
    });
});

describe("parseProperties", () => {
    it("reads the whitelist switch, past comments and blank lines", () => {
        const file = ["#Minecraft server properties", "", "white-list=true", "motd=A server", "broken"].join("\n");
        expect(parse.parseProperties(file)["white-list"]).toBe("true");
        expect(parse.parseProperties(file).motd).toBe("A server");
        expect(parse.parseProperties(file).broken).toBeUndefined();
    });

    it("keeps a value that itself contains an equals sign", () => {
        expect(parse.parseProperties("motd=1=2")["motd"]).toBe("1=2");
    });
});

describe("parseServerVersion", () => {
    it("takes the version from the most recent start", () => {
        const log = [
            "[00:00:01] [main/INFO]: Starting minecraft server version 1.21.3",
            "[00:10:01] [main/INFO]: Starting minecraft server version 1.21.4"
        ].join("\n");
        expect(parse.parseServerVersion(log)).toBe("1.21.4");
    });

    it("has no version when the log no longer reaches the start", () => {
        expect(parse.parseServerVersion("[12:00:00] [Server thread/INFO]: Alice joined the game")).toBeNull();
    });
});

describe("stripFormatting", () => {
    it("drops section codes and ANSI without touching the text", () => {
        expect(parse.stripFormatting("[32m§aAlice§r joined")).toBe("Alice joined");
    });
});

describe("lastStartupSignal", () => {
    // Taken from a real server that could not install its blueprint's plugin. It
    // restarted every few seconds for minutes, and the panel said "The server is
    // starting" the whole time - which is also what a server that is merely slow
    // says, so there was no way to tell them apart without opening the log.
    const bootLoop = [
        "[init] Running as uid=1000 gid=1000 with /data as 'drwxr-x--- 12 1000 1000 4096 Aug 12 00:17 /data'",
        "[init] Image info: buildtime=2026-08-08T21:55:36.399Z,version=java25",
        "[init] Resolving type given PAPER",
        "2026-08-12T00:18:46.537924736Z [mc-image-helper] 00:18:46.536 ERROR : Invalid parameter provided for 'modrinth' command: No candidate versions of 'BedWars1058' [25.3-SNAPSHOT=beta] matched versionType=release"
    ].join("\n");

    it("picks the line that says why it will not start", () => {
        expect(parse.lastStartupSignal(bootLoop)).toContain("No candidate versions of 'BedWars1058'");
    });

    it("says which step a slow first boot is on", () => {
        expect(parse.lastStartupSignal("[init] Resolving type given PAPER")).toBe("[init] Resolving type given PAPER");
    });

    it("ignores the game's own chatter, which is what the console is for", () => {
        const running = [
            "[12:00:00 INFO]: Done (21.5s)! For help, type \"help\"",
            "[12:00:04 INFO]: Alice joined the game"
        ].join("\n");
        expect(parse.lastStartupSignal(running)).toBeNull();
    });

    it("has nothing to say about an empty log", () => {
        expect(parse.lastStartupSignal("")).toBeNull();
    });
});

describe("parsePlayerLevels", () => {
    it("reads a level per player out of one batch of replies", () => {
        const output = [
            "Ada has the following entity data: 30",
            "Grace has the following entity data: 7"
        ].join("\n");
        expect(Object.fromEntries(parse.parsePlayerLevels(output))).toEqual({ Ada: 30, Grace: 7 });
    });

    it("leaves out somebody who logged out between the list and the question", () => {
        const output = [
            "Ada has the following entity data: 30",
            "No entity was found"
        ].join("\n");
        const found = parse.parsePlayerLevels(output);
        expect(found.get("Ada")).toBe(30);
        expect(found.size).toBe(1);
    });

    it("reads through the console's own colouring", () => {
        expect(parse.parsePlayerLevels("\u001b[0;37mAda has the following entity data: 12").get("Ada")).toBe(12);
    });

    it("has nothing to say about a server that refused the command", () => {
        expect(parse.parsePlayerLevels("Unknown or incomplete command").size).toBe(0);
    });
});
