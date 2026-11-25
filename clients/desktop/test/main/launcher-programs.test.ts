/**
 * The launcher finds the programs only the registry and the Desktop know -
 * a game its own launcher installed with no Start menu shortcut, as Rockstar
 * installs Grand Theft Auto V - and lists each program once, by every name it
 * answers to. The registry is `reg query` text from fixtures and the file
 * system is a stand-in; nothing real is read or started.
 */

import { win32 } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { topMatches } from "@/shared/launcher";
import * as programs from "../../src/main/launcher-programs";
import { parseRegQuery } from "../../src/main/launcher-stores";

const fixture = (name: string) => parseRegQuery(readFileSync(win32.join(__dirname, "..", "fixtures", "launcher", name), "utf8"));
const present = new Set([
    "D:\\Fixture Games\\Rockstar Games\\Grand Theft Auto V\\PlayGTAV.exe",
    "D:\\Fixture Games\\Rockstar Games\\Launcher\\Launcher.exe",
    "E:\\Fixture Root\\Fixture Tool\\tool.exe",
    "D:\\Fixture Apps\\Editor\\unins000.exe",
    "D:\\Fixture Apps\\Editor\\editor.exe",
    "D:\\Elsewhere\\outside.exe",
    "D:\\Fixture Apps\\Pad\\fixturepad.exe",
    "D:\\Fixture Apps\\Code\\fixturecode.exe",
    "D:\\Fixture Apps\\Quiet\\quiet.exe",
    "C:\\Program Files\\WindowsApps\\Fixture.Store_1.0_x64__fixture\\fixturestore.exe",
    "C:\\Windows\\System32\\write.exe",
    "D:\\Fixture Games\\Battle.net\\Battle.net.exe",
    "D:\\Fixture Games\\World of Warcraft\\_retail_\\Wow.exe"
]);
const folders: Record<string, string[]> = {
    "D:\\Fixture Apps\\Editor": ["D:\\Fixture Apps\\Editor\\unins000.exe", "D:\\Fixture Apps\\Editor\\editor.exe"]
};
const descriptions: Record<string, string> = {
    "D:\\Fixture Apps\\Pad\\fixturepad.exe": "Fixture Pad",
    "D:\\Fixture Apps\\Code\\fixturecode.exe": "Fixture Code - an editor for fixtures, with a long description"
};
const files: programs.ProgramFiles = {
    exists: async (path) => present.has(path),
    exes: async (folder) => folders[folder] ?? [],
    describe: async (exe) => descriptions[exe] ?? null
};
const env = { FIXTURE_ROOT: "E:\\Fixture Root", SystemRoot: "C:\\Windows" };

describe("the registry's uninstall entries", () => {
    it("lists a Rockstar game with no shortcut by its name, started through Rockstar's launcher", async () => {
        const found = await programs.uninstallPrograms(fixture("uninstall.reg.txt"), files, env);
        const gta = found.find((program) => program.label === "Grand Theft Auto V");
        expect(gta?.launch).toEqual({
            kind: "exe",
            path: "D:\\Fixture Games\\Rockstar Games\\Launcher\\Launcher.exe",
            cwd: "D:\\Fixture Games\\Rockstar Games\\Launcher",
            args: ["-launchTitleInFolder", "D:\\Fixture Games\\Rockstar Games\\Grand Theft Auto V"]
        });
        expect(gta?.target).toBe("D:\\Fixture Games\\Rockstar Games\\Grand Theft Auto V\\PlayGTAV.exe");
        expect(gta?.aliases).toEqual(expect.arrayContaining(["PlayGTAV", "GTAV", "Grand Theft Auto V"]));
    });

    it("starts a Rockstar game by its own executable when the launcher is gone", async () => {
        const gone: programs.ProgramFiles = { ...files, exists: async (path) => present.has(path) && !path.endsWith("Launcher.exe") };
        const found = await programs.uninstallPrograms(fixture("uninstall.reg.txt"), gone, env);
        expect(found.find((program) => program.label === "Grand Theft Auto V")?.launch).toEqual({
            kind: "exe",
            path: "D:\\Fixture Games\\Rockstar Games\\Grand Theft Auto V\\PlayGTAV.exe",
            cwd: "D:\\Fixture Games\\Rockstar Games\\Grand Theft Auto V"
        });
    });

    it("starts a Battle.net game through Battle.net by its product code", async () => {
        const found = await programs.uninstallPrograms(fixture("uninstall.reg.txt"), files, env);
        expect(found.find((program) => program.label === "World of Warcraft")?.launch).toEqual({
            kind: "exe",
            path: "D:\\Fixture Games\\Battle.net\\Battle.net.exe",
            cwd: "D:\\Fixture Games\\Battle.net",
            args: ["--exec=launch WoW"]
        });
    });

    it("keeps programs and leaves out runtimes, uninstallers, patches, strays and what is gone", async () => {
        const labels = (await programs.uninstallPrograms(fixture("uninstall.reg.txt"), files, env)).map((program) => program.label);
        expect(labels).toEqual(["Grand Theft Auto V", "Rockstar Games Launcher", "Fixture Tool", "Fixture Editor", "Battle.net", "World of Warcraft"]);
    });

    it("takes the install folder's main executable when the entry's icon is its uninstaller", async () => {
        const found = await programs.uninstallPrograms(fixture("uninstall.reg.txt"), files, env);
        expect(found.find((program) => program.label === "Fixture Editor")?.target).toBe("D:\\Fixture Apps\\Editor\\editor.exe");
    });

    it("reads quoted paths, icon indexes and variables, and refuses the rest", () => {
        expect(programs.registryPath("\"C:\\A B\\x.exe\",0", {})).toBe("C:\\A B\\x.exe");
        expect(programs.registryPath("C:\\A\\x.exe,-101", {})).toBe("C:\\A\\x.exe");
        expect(programs.registryPath("%ProgramFiles%\\x.exe", { ProgramFiles: "C:\\Program Files" })).toBe("C:\\Program Files\\x.exe");
        expect(programs.registryPath("%Unknown%\\x.exe", {})).toBeNull();
        expect(programs.registryPath("x.exe", {})).toBeNull();
        expect(programs.registryPath("\\\\server\\share\\x.exe", {})).toBeNull();
        expect(programs.registryPath(undefined, {})).toBeNull();
    });
});

describe("an install folder's main executable", () => {
    it("is the only program there, or the one named like the program", () => {
        expect(programs.plausibleExe("Fixture Editor", ["D:\\E\\unins000.exe", "D:\\E\\editor.exe"])).toBe("D:\\E\\editor.exe");
        expect(programs.plausibleExe("Vector Studio", ["D:\\V\\other.exe", "D:\\V\\vs.exe"])).toBe("D:\\V\\vs.exe");
        expect(programs.plausibleExe("Some Tool", ["D:\\T\\SomeTool.exe", "D:\\T\\crashhandler.exe"])).toBe("D:\\T\\SomeTool.exe");
        expect(programs.plausibleExe("Unrelated", ["D:\\T\\a.exe", "D:\\T\\b.exe"])).toBeNull();
        expect(programs.plausibleExe("Nothing", [])).toBeNull();
    });
});

describe("App Paths", () => {
    it("lists what has a description, by it when short, never the Windows folder's or a nameless helper", async () => {
        const found = await programs.appPathPrograms(fixture("app-paths.reg.txt"), files, env);
        expect(found.map((program) => program.label)).toEqual(["Fixture Pad", "fixturecode"]);
        expect(found[0]?.aliases).toEqual(expect.arrayContaining(["fixturepad"]));
        expect(found[1]?.aliases).toEqual(expect.arrayContaining(["Fixture Code - an editor for fixtures, with a long description"]));
    });
});

describe("an executable's other names", () => {
    it("drops a leading Play and a trailing version", () => {
        expect(programs.exeAliases("D:\\G\\PlayGTAV.exe")).toEqual(["PlayGTAV", "GTAV"]);
        expect(programs.exeAliases("C:\\P\\Discord.exe")).toEqual(["Discord"]);
        expect(programs.exeAliases("C:\\P\\blender-4.2.exe")).toEqual(["blender-4.2", "blender"]);
        expect(programs.exeAliases("C:\\P\\Playnite.DesktopApp.exe")).toEqual(["Playnite.DesktopApp"]);
    });
});

describe("an Internet shortcut", () => {
    it("is read for the address it opens", () => {
        expect(programs.urlShortcutTarget("[InternetShortcut]\r\nIconIndex=0\r\nURL=steam://rungameid/570\r\n")).toBe("steam://rungameid/570");
        expect(programs.urlShortcutTarget("[InternetShortcut]\r\n")).toBeNull();
    });
});

describe("one program from many sources", () => {
    it("keeps the first copy, by what it starts or by name, with every copy's names", () => {
        const exe = "D:\\Fixture Games\\Rockstar Games\\Grand Theft Auto V\\PlayGTAV.exe";
        const merged = programs.mergePrograms<programs.FoundProgram>(
            [
                [{ label: "Git Bash", path: "C:\\menu\\Git Bash.lnk" }],
                [{ label: "GTA V", path: "C:\\desk\\GTA V.lnk", target: exe, aliases: ["PlayGTAV", "GTAV"] }],
                [{ label: "Grand Theft Auto V", path: `program:${exe.toLowerCase()}`, target: exe.toUpperCase(), aliases: ["Grand Theft Auto V"] }],
                [{ label: "git bash", path: "program:c:\\git\\git-bash.exe" }]
            ],
            100
        );
        expect(merged.map((program) => program.path)).toEqual(["C:\\menu\\Git Bash.lnk", "C:\\desk\\GTA V.lnk"]);
        expect(merged[1]?.aliases).toEqual(["PlayGTAV", "GTAV", "Grand Theft Auto V"]);
        expect(merged[0]?.aliases).toEqual([]);
    });

    it("lists a Steam game once, as the store lists it, when a shortcut opens the same link", () => {
        const merged = programs.mergePrograms<programs.FoundProgram>(
            [
                [{ label: "Dota 2", path: "steam:570", launch: { kind: "uri", uri: "steam://rungameid/570" } }],
                [{ label: "Dota 2 (Steam)", path: "C:\\menu\\Dota 2.url", target: "steam://rungameid/570" }]
            ],
            100
        );
        expect(merged.map((program) => program.path)).toEqual(["steam:570"]);
        expect(merged[0]?.aliases).toEqual(["Dota 2 (Steam)"]);
    });

    it("stops at the limit", () => {
        const many = Array.from({ length: 10 }, (_, index) => ({ label: `App ${index}`, path: `p${index}` }));
        expect(programs.mergePrograms([many], 3)).toHaveLength(3);
    });

    it("finds the uninstall entry's game by its initials, above a name with the letters merely in order", async () => {
        const found = programs.mergePrograms([[{ label: "Git Bash", path: "git" }], await programs.uninstallPrograms(fixture("uninstall.reg.txt"), files, env)], 100);
        const search = found.map((program) => ({ ...program, context: "" }));
        expect(topMatches("gta", search, 5)[0]?.label).toBe("Grand Theft Auto V");
        expect(topMatches("gtav", search, 5)[0]?.label).toBe("Grand Theft Auto V");
        expect(topMatches("playgtav", search, 5)[0]?.label).toBe("Grand Theft Auto V");
    });
});

describe("the Desktop folders", () => {
    it("are this user's as Windows knows it, and everyone's, each once", () => {
        const env = { USERPROFILE: "C:\\Users\\fixture", PUBLIC: "C:\\Users\\Public" };
        expect(programs.desktopFolders("C:\\Users\\fixture\\OneDrive\\Desktop", env)).toEqual(["C:\\Users\\fixture\\OneDrive\\Desktop", "C:\\Users\\Public\\Desktop"]);
        expect(programs.desktopFolders(undefined, env)).toEqual(["C:\\Users\\fixture\\Desktop", "C:\\Users\\Public\\Desktop"]);
        expect(programs.desktopFolders("C:\\U\\Desktop", { PUBLIC: "c:\\u" })).toEqual(["C:\\U\\Desktop"]);
        expect(programs.desktopFolders(undefined, {})).toEqual([]);
    });
});
