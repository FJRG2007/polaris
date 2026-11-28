/**
 * A program is a game when it lives in a folder one of the stores keeps a game
 * in, whichever source listed it: the Start menu shortcut Grand Theft Auto V
 * has (Rockstar, Steam, Epic) used to make it an Application while Fortnite,
 * which has none, was a Game. Each store's own record is a fixture here; the
 * file system, the registry and PowerShell are stand-ins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const dirs = new Map<string, string[]>();

vi.mock("node:fs/promises", () => ({
    stat: vi.fn(async (path: string) => {
        if (files.has(path)) return { isFile: () => true, size: (files.get(path) as string).length };
        if (dirs.has(path)) return { isFile: () => false, size: 0 };
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    readFile: vi.fn(async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return files.get(path);
    }),
    readdir: vi.fn(async (path: string) => {
        if (!dirs.has(path)) throw new Error("ENOENT");
        return dirs.get(path);
    })
}));
vi.mock("node:child_process", () => ({
    execFile: vi.fn((_file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => done(new Error("not found"), ""))
}));

const stores = await import("../../src/main/launcher-stores");
const { listedGame, storeGameFolders } = await import("../../src/main/game-detect");
const { mergePrograms } = await import("../../src/main/launcher-programs");

const reg = (text: string) => stores.parseRegQuery(text.replace(/^\n/, ""));
const GTA = "C:\\Program Files\\Rockstar Games\\Grand Theft Auto V";
const STEAM_GTA = "D:\\SteamLibrary\\steamapps\\common\\Grand Theft Auto V";

beforeEach(() => {
    files.clear();
    dirs.clear();
});

describe("each store's own record", () => {
    it("Rockstar: a title key with InstallFolder, and the ones bought on Steam or Epic, not the launcher", () => {
        const keys = reg(`
HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Grand Theft Auto V
    InstallFolder    REG_SZ    ${GTA}\\
    InstallFolderSteam    REG_SZ    ${STEAM_GTA}

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Launcher
    InstallFolder    REG_SZ    C:\\Program Files\\Rockstar Games\\Launcher
`);
        expect(stores.rockstarFolders(keys)).toEqual([
            { name: "Grand Theft Auto V", folder: GTA, store: "rockstar:grand-theft-auto-v" },
            { name: "Grand Theft Auto V", folder: STEAM_GTA, store: "rockstar:grand-theft-auto-v" }
        ]);
    });

    it("EA: the EA Games key's Install Dir, and Origin's manifest path", () => {
        const keys = reg(`
HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\EA Games\\Battlefield 2042
    Install Dir    REG_SZ    C:\\Program Files\\EA Games\\Battlefield 2042\\
`);
        expect(stores.eaFolders(keys)).toEqual([{ name: "Battlefield 2042", folder: "C:\\Program Files\\EA Games\\Battlefield 2042", store: "ea:battlefield-2042" }]);
        expect(stores.originInstallPath("?dipinstallpath=C%3A%5CGames%5CFIFA%2023&other=1")).toBe("C:\\Games\\FIFA 23");
        expect(stores.originInstallPath("nothing")).toBeNull();
    });

    it("Battle.net: Blizzard's uninstall entries with a location, not the client", () => {
        const keys = reg(`
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Overwatch
    DisplayName    REG_SZ    Overwatch 2
    Publisher    REG_SZ    Blizzard Entertainment
    InstallLocation    REG_SZ    C:\\Program Files (x86)\\Overwatch

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net
    DisplayName    REG_SZ    Battle.net
    Publisher    REG_SZ    Blizzard Entertainment
    InstallLocation    REG_SZ    C:\\Program Files (x86)\\Battle.net
`);
        expect(stores.battleNetFolders(keys).map((game) => game.name)).toEqual(["Overwatch 2"]);
    });

    it("Windows' Game Bar match, never a system folder", () => {
        const keys = reg(`
HKEY_CURRENT_USER\\System\\GameConfigStore\\Children\\a1
    MatchedExeFullPath    REG_SZ    E:\\Games\\Hades\\x64\\Hades.exe

HKEY_CURRENT_USER\\System\\GameConfigStore\\Children\\b2
    MatchedExeFullPath    REG_SZ    C:\\Windows\\System32\\notepad.exe
`);
        expect(stores.gameConfigFolders(keys, "C:\\Windows").map((game) => game.folder)).toEqual(["E:\\Games\\Hades\\x64"]);
    });

    it("Xbox: a title folder holding MicrosoftGame.config, on any drive", async () => {
        dirs.set("D:\\XboxGames", ["Forza Horizon 5", "NotAGame"]);
        files.set("D:\\XboxGames\\Forza Horizon 5\\Content\\MicrosoftGame.config", "<Game/>");
        expect(await stores.xboxFolders("CD")).toEqual([{ name: "Forza Horizon 5", folder: "D:\\XboxGames\\Forza Horizon 5\\Content", store: "xbox:forza-horizon-5" }]);
    });

    it("EA app: an InstallData title whose game folder is on a drive", async () => {
        dirs.set("C:\ProgramData\EA Desktop\InstallData", ["Fixture Game", "base-Origin.SFT.50.0000000", "Gone Game"]);
        dirs.set("D:\EA Games\Fixture Game", []);
        expect(await stores.eaAppFolders("C:\ProgramData", "CD")).toEqual([{ name: "Fixture Game", folder: "D:\EA Games\Fixture Game", store: "ea:fixture-game" }]);
    });

    it("Origin: the LocalContent manifest of an installed game", async () => {
        dirs.set("C:\\ProgramData\\Origin\\LocalContent", ["FIFA 23"]);
        dirs.set("C:\\ProgramData\\Origin\\LocalContent\\FIFA 23", ["FIFA 23.mfst"]);
        files.set("C:\\ProgramData\\Origin\\LocalContent\\FIFA 23\\FIFA 23.mfst", "?id=x&dipinstallpath=D%3A%5CGames%5CFIFA%2023&y=1");
        expect((await stores.originFolders("C:\\ProgramData")).map((game) => game.folder)).toEqual(["D:\\Games\\FIFA 23"]);
    });
});

describe("a listed program is a game by where it lives", () => {
    const game = (name: string, folder: string, store: string) => ({ name, folder, store });

    it("GTA V by its Start menu shortcut is a game from Rockstar, Steam and Epic; Fortnite too", () => {
        const folders = storeGameFolders([
            game("Grand Theft Auto V", GTA, "rockstar:grand-theft-auto-v"),
            game("Grand Theft Auto V", STEAM_GTA, "steam:271590"),
            game("Grand Theft Auto V", "E:\\Epic\\GTAV", "epic:ns:item"),
            game("Fortnite", "C:\\Program Files\\Epic Games\\Fortnite", "epic:fn:fn")
        ]);
        const shortcut = (target: string) => ({ label: "Grand Theft Auto V", path: "C:\\Start\\GTA V.lnk", launch: { kind: "open" }, target });
        expect(listedGame(shortcut(`${GTA}\\PlayGTAV.exe`), folders)?.store).toBe("rockstar:grand-theft-auto-v");
        expect(listedGame(shortcut(`${STEAM_GTA}\\GTA5.exe`), folders)?.store).toBe("steam:271590");
        expect(listedGame(shortcut("E:\\Epic\\GTAV\\GTA5.exe"), folders)?.store).toBe("epic:ns:item");
        expect(listedGame({ label: "Fortnite", path: "epic:fn", folder: "C:\\Program Files\\Epic Games\\Fortnite" }, folders)?.store).toBe("epic:fn:fn");
    });

    it("an uninstall entry's folder counts; a program elsewhere, the launcher and a helper inside do not", () => {
        const folders = storeGameFolders([game("Grand Theft Auto V", GTA, "rockstar:grand-theft-auto-v")]);
        expect(listedGame({ label: "GTA V", path: "uninstall:gtav", folder: GTA }, folders)).not.toBeNull();
        expect(listedGame({ label: "Notepad", path: "C:\\Windows\\notepad.exe" }, folders)).toBeNull();
        expect(listedGame({ label: "Launcher", path: "x", target: "C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe" }, folders)).toBeNull();
        expect(listedGame({ label: "Setup", path: "x", target: `${GTA}\\setup.exe` }, folders)).toBeNull();
    });

    it("still finds GTA V when the merged listing kept the shortcut rather than the store's copy", () => {
        const merged = mergePrograms(
            [[{ label: "Grand Theft Auto V", path: "C:\\Start\\GTA V.lnk", launch: { kind: "open" as const, path: "C:\\Start\\GTA V.lnk" }, target: `${GTA}\\PlayGTAV.exe` }]],
            10
        );
        const folders = storeGameFolders([game("Grand Theft Auto V", GTA, "rockstar:grand-theft-auto-v")]);
        expect(listedGame(merged[0]!, folders)).not.toBeNull();
    });
});
