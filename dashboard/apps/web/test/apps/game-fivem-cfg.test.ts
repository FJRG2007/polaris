/**
 * `server.cfg`, read and written the way the console reads it.
 *
 * The whole of a FiveM server's configuration is this one file, and it is a list
 * of console commands rather than a settings file - which is what makes editing it
 * from a screen worth pinning down. The same value can be spelled three ways, a
 * line may be commented out, and a key set twice takes the last one. Getting any
 * of that wrong is a save that appears to work and changes nothing.
 *
 * The thing being defended against here is the second copy: a Save that appends a
 * new line every time is a file that stops being editable by hand within a month.
 */

import * as cfg from "@/lib/apps/fivem/cfg";
import { describe, expect, it } from "vitest";

const HOSTNAME = { key: "sv_hostname", prefix: "" } as const;
const TAGS = { key: "tags", prefix: "sets" } as const;
const POPULATION = { key: "onesync_population", prefix: "set" } as const;

const FILE = [
    "# you probably don't want to change these!",
    'endpoint_add_tcp "0.0.0.0:30120"',
    "",
    "ensure chat",
    "ensure hardcap",
    "",
    'sv_hostname "My new Dockerized FXServer"',
    "sv_maxclients 32",
    'sets tags "roleplay, economy"',
    "#sv_master1 \"\""
].join("\n");

describe("a line", () => {
    it("is split the way the console splits it, quotes and all", () => {
        expect(cfg.tokenize('sv_hostname "My server"')).toEqual(["sv_hostname", "My server"]);
        expect(cfg.tokenize("sv_maxclients   32")).toEqual(["sv_maxclients", "32"]);
        expect(cfg.tokenize('set steam_webApiKey ""')).toEqual(["set", "steam_webApiKey", ""]);
    });
});

describe("reading", () => {
    it("finds a bare command and a prefixed one", () => {
        expect(cfg.readSetting(FILE, HOSTNAME)).toBe("My new Dockerized FXServer");
        expect(cfg.readSetting(FILE, TAGS)).toBe("roleplay, economy");
    });

    it("does not read a commented line", () => {
        expect(cfg.readSetting(FILE, { key: "sv_master1", prefix: "" })).toBe(null);
    });

    it("takes the last of a key that is set twice, which is what the console does", () => {
        const twice = `${FILE}\nsv_maxclients 48`;
        expect(cfg.readSetting(twice, { key: "sv_maxclients", prefix: "" })).toBe("48");
    });

    it("keeps the prefixes apart, because they are different variables", () => {
        // `sets tags` is advertised to the browser; `set tags` would not be.
        expect(cfg.readSetting(FILE, { key: "tags", prefix: "set" })).toBe(null);
    });

    it("collects a directive that is a list rather than a setting", () => {
        expect(cfg.readAll(FILE, { key: "ensure", prefix: "" })).toEqual(["chat", "hardcap"]);
    });
});

describe("writing", () => {
    it("rewrites the line that was already there rather than adding one", () => {
        const next = cfg.writeSetting(FILE, HOSTNAME, "Los Santos");
        expect(cfg.readSetting(next, HOSTNAME)).toBe("Los Santos");
        expect(next.split("\n").filter((line) => line.startsWith("sv_hostname"))).toHaveLength(1);
    });

    it("appends a key the file did not have, with its prefix", () => {
        const next = cfg.writeSetting(FILE, POPULATION, "false");
        expect(next).toContain("set onesync_population false");
        expect(cfg.readSetting(next, POPULATION)).toBe("false");
    });

    it("quotes a value the console would otherwise split", () => {
        const next = cfg.writeSetting(FILE, HOSTNAME, "Los Santos RP");
        expect(next).toContain('sv_hostname "Los Santos RP"');
    });

    it("takes the line out when the value is null", () => {
        const next = cfg.writeSetting(FILE, HOSTNAME, null);
        expect(cfg.readSetting(next, HOSTNAME)).toBe(null);
        expect(next).not.toContain("sv_hostname");
    });

    it("keeps one live line and drops the dead ones above it", () => {
        const twice = `${FILE}\nsv_maxclients 48`;
        const next = cfg.writeSetting(twice, { key: "sv_maxclients", prefix: "" }, "64");
        expect(next.split("\n").filter((line) => line.trim().startsWith("sv_maxclients"))).toEqual([
            "sv_maxclients 64"
        ]);
    });

    it("refuses a value the format cannot carry rather than mangling it", () => {
        expect(() => cfg.writeSetting(FILE, HOSTNAME, 'a "quoted" name')).toThrow();
    });

    it("leaves everything else in the file exactly as it was", () => {
        const next = cfg.writeSetting(FILE, HOSTNAME, "Los Santos");
        expect(next).toContain("# you probably don't want to change these!");
        expect(next).toContain('endpoint_add_tcp "0.0.0.0:30120"');
        expect(cfg.readAll(next, { key: "ensure", prefix: "" })).toEqual(["chat", "hardcap"]);
    });
});

describe("a managed block", () => {
    it("is written once and rewritten in place after that", () => {
        const once = cfg.writeBlock(FILE, "Polaris administrators", ["add_ace group.admin command allow"]);
        const twice = cfg.writeBlock(once, "Polaris administrators", [
            "add_ace group.admin command allow",
            "add_principal identifier.license:abc group.admin"
        ]);
        expect(cfg.readBlock(twice, "Polaris administrators")).toEqual([
            "add_ace group.admin command allow",
            "add_principal identifier.license:abc group.admin"
        ]);
        // One block, not two: a second pass must not leave the first behind.
        expect(twice.split("# end Polaris administrators")).toHaveLength(2);
    });

    it("empties without disappearing, so the state is readable", () => {
        const once = cfg.writeBlock(FILE, "Polaris resources", ["ensure polaris"]);
        const emptied = cfg.writeBlock(once, "Polaris resources", []);
        expect(cfg.readBlock(emptied, "Polaris resources")).toEqual([]);
        expect(emptied).toContain("# end Polaris resources");
    });

    it("does not disturb the settings around it", () => {
        const next = cfg.writeBlock(FILE, "Polaris resources", ["ensure polaris"]);
        expect(cfg.readSetting(next, HOSTNAME)).toBe("My new Dockerized FXServer");
    });
});
