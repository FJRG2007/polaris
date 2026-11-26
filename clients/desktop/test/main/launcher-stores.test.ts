/**
 * The launcher finds what Windows' own search misses - Store apps and the
 * games of Epic, Steam, GOG and Ubisoft - from each store's own files, and
 * launches them only through the store's fixed link or the game's own
 * executable. The file system, the registry and PowerShell are stand-ins; no
 * real store, registry key or program is read or started.
 */

import { win32 } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const dirs = new Map<string, string[]>();
const commands = new Map<string, string>();

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
    execFile: vi.fn((file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
        const output = commands.get([file, ...args].join(" "));
        if (output === undefined) done(new Error("not found"), "");
        else done(null, output);
    })
}));

const stores = await import("../../src/main/launcher-stores");
const { rankedMatches } = await import("../../src/shared/launcher");

const { join } = win32;
const base = "C:\\fixture";
const file = (path: string, text: string) => files.set(path, text);
const dir = (path: string, names: string[] = []) => dirs.set(path, names);
/** `reg` takes the short hive name and prints the long one. */
const long = (key: string) => key.replace(/^HKLM/, "HKEY_LOCAL_MACHINE");

beforeEach(() => {
    files.clear();
    dirs.clear();
    commands.clear();
});

describe("Store and Xbox apps", () => {
    it("lists packaged apps by their AppUserModelID and leaves desktop programs to the Start menu", async () => {
        const script = "Get-StartApps | Where-Object { $_.AppID -like '*!*' } | Select-Object Name,AppID | ConvertTo-Json -Compress";
        commands.set(
            `powershell.exe -NoProfile -NonInteractive -Command ${script}`,
            JSON.stringify([
                { Name: "Xbox", AppID: "Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App" },
                { Name: "Notepad++", AppID: "C:\\Program Files\\Notepad++\\notepad++.exe" },
                { Name: "Bad; id", AppID: "x!y & calc" }
            ])
        );
        const apps = await stores.packagedApps();
        expect(apps).toEqual([
            {
                label: "Xbox",
                path: "packaged:Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App",
                launch: { kind: "packaged", id: "Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App" }
            }
        ]);
    });

    it("reads a single app, which PowerShell prints as an object rather than a list", async () => {
        const script = "Get-StartApps | Where-Object { $_.AppID -like '*!*' } | Select-Object Name,AppID | ConvertTo-Json -Compress";
        commands.set(`powershell.exe -NoProfile -NonInteractive -Command ${script}`, JSON.stringify({ Name: "Calculator", AppID: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" }));
        expect((await stores.packagedApps()).map((app) => app.label)).toEqual(["Calculator"]);
    });
});

describe("Epic Games", () => {
    const manifests = join(base, "Epic", "EpicGamesLauncher", "Data", "Manifests");
    const fortnite = join(base, "Games", "Fortnite");

    it("lists an installed game with Epic's own launch link and its executable's icon", async () => {
        dir(fortnite);
        dir(manifests, ["A.item", "B.item", "C.item", "D.item", "notes.txt"]);
        file(join(manifests, "A.item"), JSON.stringify({
            DisplayName: "Fortnite",
            AppName: "Fortnite",
            CatalogNamespace: "fn",
            CatalogItemId: "4fe75bbc5a674f4f9b356b5c90567da5",
            InstallLocation: fortnite,
            LaunchExecutable: "FortniteGame/Binaries/Win64/FortniteLauncher.exe",
            AppCategories: ["public", "games", "applications"]
        }));
        // A downloadable add-on, an install still running and one pointing out of its folder.
        file(join(manifests, "B.item"), JSON.stringify({ DisplayName: "Skin pack", AppName: "a", CatalogNamespace: "fn", CatalogItemId: "b", InstallLocation: fortnite, AppCategories: ["addons"] }));
        file(join(manifests, "C.item"), JSON.stringify({ DisplayName: "Half done", AppName: "c", CatalogNamespace: "fn", CatalogItemId: "d", InstallLocation: fortnite, bIsIncompleteInstall: true }));
        file(join(manifests, "D.item"), "{ not json");
        const [game, ...rest] = await stores.epicGames(base);
        expect(rest).toEqual([]);
        expect(game).toEqual({
            label: "Fortnite",
            path: "epic:Fortnite",
            launch: { kind: "uri", uri: "com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true" },
            icon: join(fortnite, "FortniteGame/Binaries/Win64/FortniteLauncher.exe"),
            folder: fortnite,
            store: "epic:fn:4fe75bbc5a674f4f9b356b5c90567da5"
        });
        expect(stores.isVettedLaunchUri((game as { launch: { uri: string; }; }).launch.uri)).toBe(true);
    });

    it("refuses ids that would change the link, and an executable outside the game's folder", async () => {
        dir(fortnite);
        dir(manifests, ["A.item", "B.item"]);
        file(join(manifests, "A.item"), JSON.stringify({ DisplayName: "X", AppName: "x?action=uninstall", CatalogNamespace: "fn", CatalogItemId: "i", InstallLocation: fortnite }));
        file(join(manifests, "B.item"), JSON.stringify({ DisplayName: "Y", AppName: "y", CatalogNamespace: "fn", CatalogItemId: "i", InstallLocation: fortnite, LaunchExecutable: "../../Windows/System32/cmd.exe" }));
        const games = await stores.epicGames(base);
        expect(games.map((game) => game.label)).toEqual(["Y"]);
        expect(games[0]?.icon).toBeUndefined();
    });

    it("leaves out content installed inside another game, as Fortnite's own modes are", async () => {
        dir(fortnite);
        dir(manifests, ["A.item", "B.item", "C.item"]);
        file(join(manifests, "A.item"), JSON.stringify({
            DisplayName: "Fortnite", AppName: "Fortnite", CatalogNamespace: "fn", CatalogItemId: "4fe75bbc5a674f4f9b356b5c90567da5",
            InstallLocation: fortnite, AppCategories: ["games", "applications"], MainGameAppName: "", bIsApplication: true
        }));
        // The fields a real "Save the World" manifest carries: hidden, not an application, inside Fortnite.
        file(join(manifests, "B.item"), JSON.stringify({
            DisplayName: "Fortnite Save the World Content", AppName: "aa31f9e94e844b299ca757d1d0b97a09", CatalogNamespace: "fn",
            CatalogItemId: "0b41f0192f7f4f2691684581aedc0778", InstallLocation: fortnite, AppCategories: ["hidden"],
            MainGameAppName: "Fortnite", bIsApplication: false
        }));
        // Named after its game but missing the application flag: still part of it.
        file(join(manifests, "C.item"), JSON.stringify({
            DisplayName: "LEGO Fortnite Content", AppName: "94bc5ec13f8f438c97fdbef3e9019e27", CatalogNamespace: "fn",
            CatalogItemId: "b619cf61a4144d67bd753dc990637e7c", InstallLocation: fortnite, MainGameAppName: "Fortnite"
        }));
        expect((await stores.epicGames(base)).map((game) => game.label)).toEqual(["Fortnite"]);
    });

    it("ranks Fortnite first for \"fortnite\" and \"fort\", ahead of other installed games that share the letters", async () => {
        const other = (name: string) => join(base, "Games", name);
        dir(fortnite);
        for (const name of ["FortSolis", "ComfortZone", "RocketLeague"]) dir(other(name));
        // The other games come first on disk, so listing order cannot be what puts Fortnite on top.
        dir(manifests, ["1.item", "2.item", "3.item", "4.item", "5.item"]);
        file(join(manifests, "1.item"), JSON.stringify({ DisplayName: "Fort Solis", AppName: "FortSolis", CatalogNamespace: "fs", CatalogItemId: "i1", InstallLocation: other("FortSolis"), AppCategories: ["games"] }));
        file(join(manifests, "2.item"), JSON.stringify({ DisplayName: "Comfort Zone", AppName: "ComfortZone", CatalogNamespace: "cz", CatalogItemId: "i2", InstallLocation: other("ComfortZone"), AppCategories: ["games"] }));
        file(join(manifests, "3.item"), JSON.stringify({ DisplayName: "Rocket League", AppName: "Sugar", CatalogNamespace: "rl", CatalogItemId: "i3", InstallLocation: other("RocketLeague"), AppCategories: ["games"] }));
        file(join(manifests, "4.item"), JSON.stringify({
            DisplayName: "Fortnite Save the World Content", AppName: "aa31f9e94e844b299ca757d1d0b97a09", CatalogNamespace: "fn",
            CatalogItemId: "0b41f0192f7f4f2691684581aedc0778", InstallLocation: fortnite, AppCategories: ["hidden"],
            MainGameAppName: "Fortnite", bIsApplication: false
        }));
        // Fortnite as it was when it went missing: Epic updating it.
        file(join(manifests, "5.item"), JSON.stringify({
            DisplayName: "Fortnite", AppName: "Fortnite", CatalogNamespace: "fn", CatalogItemId: "4fe75bbc5a674f4f9b356b5c90567da5",
            InstallLocation: fortnite, LaunchExecutable: "FortniteGame/Binaries/Win64/FortniteLauncher.exe",
            AppCategories: ["public", "games", "applications"], MainGameAppName: "", bIsApplication: true, bIsIncompleteInstall: true
        }));
        file(join(fortnite, "FortniteGame", "Binaries", "Win64", "FortniteLauncher.exe"), "exe");
        const games = (await stores.epicGames(base)).map((game) => ({ ...game, context: "" }));
        expect(games.map((game) => game.label)).toEqual(["Fort Solis", "Comfort Zone", "Rocket League", "Fortnite"]);
        for (const query of ["fortnite", "fort", "Fortnite", "FORT"]) {
            const [first] = rankedMatches(query, games, 8, (game) => `app:${game.path}`, new Map());
            expect(first?.path, query).toBe("epic:Fortnite");
        }
    });

    it("keeps a game listed while Epic updates it, and hides a first install that never finished", async () => {
        const fresh = join(base, "Games", "NewGame");
        dir(fortnite);
        dir(fresh);
        dir(manifests, ["A.item", "B.item"]);
        // Epic sets the same flag for an update and a first install; only the update has its executable on disk.
        file(join(manifests, "A.item"), JSON.stringify({
            DisplayName: "Fortnite", AppName: "Fortnite", CatalogNamespace: "fn", CatalogItemId: "4fe75bbc5a674f4f9b356b5c90567da5",
            InstallLocation: fortnite, LaunchExecutable: "FortniteGame/Binaries/Win64/FortniteLauncher.exe", bIsIncompleteInstall: true
        }));
        file(join(fortnite, "FortniteGame", "Binaries", "Win64", "FortniteLauncher.exe"), "exe");
        file(join(manifests, "B.item"), JSON.stringify({
            DisplayName: "New Game", AppName: "NewGame", CatalogNamespace: "ng", CatalogItemId: "i", InstallLocation: fresh,
            LaunchExecutable: "Binaries/NewGame.exe", bIsIncompleteInstall: true
        }));
        const games = await stores.epicGames(base);
        expect(games.map((game) => [game.label, game.updating])).toEqual([["Fortnite", true]]);
        expect(games[0]?.launch).toEqual({ kind: "uri", uri: "com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true" });
    });

    it("gives no folder to an engine, so running it is never a game", async () => {
        const engine = join(base, "Epic Games", "UE_5.3");
        dir(engine);
        dir(manifests, ["E.item"]);
        file(join(manifests, "E.item"), JSON.stringify({ DisplayName: "Unreal Engine", AppName: "UE_5.3", CatalogNamespace: "ue", CatalogItemId: "i", InstallLocation: engine }));
        const [app] = await stores.epicGames(base);
        expect(app?.label).toBe("Unreal Engine");
        expect(app?.folder).toBeUndefined();
    });

    it("lists nothing when Epic is not installed", async () => {
        expect(await stores.epicGames(base)).toEqual([]);
    });
});

describe("Steam", () => {
    const steam = join(base, "Steam");
    const second = join(base, "SteamLibrary");

    it("lists fully installed games from every library folder, without Steam's own tools", async () => {
        commands.set("reg.exe query HKCU\\Software\\Valve\\Steam /v SteamPath", `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${steam}\r\n\r\n`);
        file(join(steam, "steamapps", "libraryfolders.vdf"), `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam.replace(/\\/g, "\\\\")}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${second.replace(/\\/g, "\\\\")}"\n\t\t"apps"\n\t\t{\n\t\t\t"730"\t\t"1"\n\t\t}\n\t}\n}\n`);
        dir(join(steam, "steamapps"), ["appmanifest_228980.acf", "libraryfolders.vdf"]);
        dir(join(second, "steamapps"), ["appmanifest_730.acf", "appmanifest_570.acf"]);
        file(join(steam, "steamapps", "appmanifest_228980.acf"), `"AppState"\n{\n\t"appid"\t\t"228980"\n\t"name"\t\t"Steamworks Common Redistributables"\n\t"StateFlags"\t\t"4"\n}\n`);
        file(join(second, "steamapps", "appmanifest_730.acf"), `"AppState"\n{\n\t"appid"\t\t"730"\n\t"name"\t\t"Counter-Strike 2"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Counter-Strike Global Offensive"\n\t// a comment\n}\n`);
        file(join(second, "steamapps", "appmanifest_570.acf"), `"AppState"\n{\n\t"appid"\t\t"570"\n\t"name"\t\t"Dota 2"\n\t"StateFlags"\t\t"1026"\n}\n`);
        file(join(steam, "appcache", "librarycache", "730_icon.jpg"), "jpg");
        expect(await stores.steamGames(undefined)).toEqual([
            {
                label: "Counter-Strike 2",
                path: "steam:730",
                launch: { kind: "uri", uri: "steam://rungameid/730" },
                icon: join(steam, "appcache", "librarycache", "730_icon.jpg"),
                folder: join(second, "steamapps", "common", "Counter-Strike Global Offensive"),
                store: "steam:730"
            }
        ]);
    });

    it("gives no folder to a game whose install folder climbs out of the library", async () => {
        commands.set("reg.exe query HKCU\\Software\\Valve\\Steam /v SteamPath", `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${steam}\r\n\r\n`);
        dir(join(steam, "steamapps"), ["appmanifest_10.acf"]);
        file(join(steam, "steamapps", "appmanifest_10.acf"), `"AppState"\n{\n\t"appid"\t\t"10"\n\t"name"\t\t"Odd"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"..\\\\..\\\\.."\n}\n`);
        const [game] = await stores.steamGames(undefined);
        expect(game?.label).toBe("Odd");
        expect(game?.folder).toBeUndefined();
    });

    it("leaves out a soundtrack, which Steam installs as music rather than as a program", async () => {
        commands.set("reg.exe query HKCU\\Software\\Valve\\Steam /v SteamPath", `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${steam}\r\n\r\n`);
        dir(join(steam, "steamapps"), ["appmanifest_20.acf", "appmanifest_21.acf"]);
        file(join(steam, "steamapps", "appmanifest_20.acf"), `"AppState"\n{\n\t"appid"\t\t"20"\n\t"name"\t\t"Hades II"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Hades II"\n}\n`);
        file(join(steam, "steamapps", "appmanifest_21.acf"), `"AppState"\n{\n\t"appid"\t\t"21"\n\t"name"\t\t"Hades II Soundtrack"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Hades II Soundtrack"\n}\n`);
        dir(join(steam, "steamapps", "common", "Hades II"));
        dir(join(steam, "steamapps", "music", "Hades II Soundtrack"));
        expect((await stores.steamGames(undefined)).map((game) => game.label)).toEqual(["Hades II"]);
    });

    it("keeps a game listed while Steam updates it, and hides a first download", async () => {
        commands.set("reg.exe query HKCU\\Software\\Valve\\Steam /v SteamPath", `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${steam}\r\n\r\n`);
        const acf = (id: string, name: string, flags: number, buildid: string) =>
            `"AppState"\n{\n\t"appid"\t\t"${id}"\n\t"name"\t\t"${name}"\n\t"StateFlags"\t\t"${flags}"\n\t"installdir"\t\t"${name}"\n\t"buildid"\t\t"${buildid}"\n}\n`;
        dir(join(steam, "steamapps"), ["appmanifest_1.acf", "appmanifest_2.acf", "appmanifest_3.acf", "appmanifest_4.acf", "appmanifest_5.acf"]);
        // Update downloading: no longer fully installed, the old build still in its folder.
        file(join(steam, "steamapps", "appmanifest_1.acf"), acf("1", "Updating", 1026, "15821234"));
        dir(join(steam, "steamapps", "common", "Updating"), ["Updating.exe"]);
        // Fully installed with an update running.
        file(join(steam, "steamapps", "appmanifest_2.acf"), acf("2", "Patching", 4 | 256, "900"));
        dir(join(steam, "steamapps", "common", "Patching"), ["Patching.exe"]);
        // First download: no build installed yet, even with files already preallocated.
        file(join(steam, "steamapps", "appmanifest_3.acf"), acf("3", "Downloading", 1026, "0"));
        dir(join(steam, "steamapps", "common", "Downloading"), ["Downloading.exe"]);
        // A build id but an empty folder: nothing to play.
        file(join(steam, "steamapps", "appmanifest_4.acf"), acf("4", "Empty", 1026, "77"));
        dir(join(steam, "steamapps", "common", "Empty"));
        // Being uninstalled.
        file(join(steam, "steamapps", "appmanifest_5.acf"), acf("5", "Leaving", 4 | 2048, "88"));
        dir(join(steam, "steamapps", "common", "Leaving"), ["Leaving.exe"]);
        const games = await stores.steamGames(undefined);
        expect(games.map((game) => [game.label, game.updating])).toEqual([["Updating", true], ["Patching", true]]);
        expect(games[0]?.launch).toEqual({ kind: "uri", uri: "steam://rungameid/1" });
    });
    it("reads Valve's format strictly, and gives up on a broken file", () => {
        expect(stores.parseVdf(`"a" { "b" "c\\"d" }`)).toEqual({ a: { b: "c\"d" } });
        expect(stores.parseVdf(`"a" { "b" "c"`)).toBeNull();
        expect(stores.parseVdf(`"a" }`)).toBeNull();
        expect(stores.parseVdf("a b")).toBeNull();
    });
});

describe("GOG", () => {
    const hive = "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    const game = join(base, "GOG Games", "Witcher 3");

    it("starts the primary play task inside the game's folder, and nothing that takes arguments", async () => {
        commands.set(`reg.exe query ${hive} /s /f GOG.com /d /e`, `\r\n${long(hive)}\\1207664663_is1\r\n    Publisher    REG_SZ    GOG.com\r\n\r\n${long(hive)}\\1495134320_is1\r\n    Publisher    REG_SZ    GOG.com\r\n\r\nEnd of search: 2 match(es) found.\r\n`);
        commands.set(`reg.exe query ${hive}\\1207664663_is1`, `\r\n${long(hive)}\\1207664663_is1\r\n    InstallLocation    REG_SZ    ${game}\r\n    DisplayName    REG_SZ    The Witcher 3\r\n`);
        commands.set(`reg.exe query ${hive}\\1495134320_is1`, `\r\n${long(hive)}\\1495134320_is1\r\n    InstallLocation    REG_SZ    ${game}\r\n`);
        dir(game);
        file(join(game, "goggame-1207664663.info"), JSON.stringify({ name: "The Witcher 3: Wild Hunt", playTasks: [{ isPrimary: true, type: "FileTask", path: "bin\\x64\\witcher3.exe" }] }));
        file(join(game, "goggame-1495134320.info"), JSON.stringify({ name: "Other", playTasks: [{ isPrimary: true, type: "FileTask", path: "run.exe", arguments: "-x" }] }));
        const apps = await stores.gogGames();
        expect(apps).toEqual([
            {
                label: "The Witcher 3: Wild Hunt",
                path: "gog:1207664663",
                launch: { kind: "exe", path: join(game, "bin\\x64\\witcher3.exe"), cwd: game },
                icon: join(game, "bin\\x64\\witcher3.exe"),
                folder: game,
                store: "gog:1207664663"
            }
        ]);
    });
});

describe("GOG downloadable content", () => {
    const hive = "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    const game = join(base, "GOG Games", "Witcher 3");

    it("leaves out a DLC whose info names another game as its root", async () => {
        commands.set(`reg.exe query ${hive} /s /f GOG.com /d /e`, `\r\n${long(hive)}\\1640424747_is1\r\n    Publisher    REG_SZ    GOG.com\r\n\r\n`);
        commands.set(`reg.exe query ${hive}\\1640424747_is1`, `\r\n${long(hive)}\\1640424747_is1\r\n    InstallLocation    REG_SZ    ${game}\r\n    DisplayName    REG_SZ    Blood and Wine\r\n`);
        dir(game);
        file(join(game, "goggame-1640424747.info"), JSON.stringify({
            name: "Blood and Wine", gameId: "1640424747", rootGameId: "1207664663",
            playTasks: [{ isPrimary: true, type: "FileTask", path: "bin\\x64\\witcher3.exe" }]
        }));
        expect(await stores.gogGames()).toEqual([]);
    });
});

describe("Ubisoft Connect", () => {
    it("lists each install by its folder's name with Ubisoft's own link", async () => {
        const hive = "HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs";
        const game = join(base, "Ubisoft", "Assassin's Creed Valhalla");
        dir(game);
        commands.set(`reg.exe query ${hive} /s`, `\r\n${long(hive)}\\13504\r\n    InstallDir    REG_SZ    ${game.replace(/\\/g, "/")}/\r\n\r\n${long(hive)}\\999\r\n    InstallDir    REG_SZ    ${join(base, "gone")}\r\n`);
        const apps = await stores.ubisoftGames();
        expect(apps.map((app) => [app.label, app.launch, app.folder])).toEqual([["Assassin's Creed Valhalla", { kind: "uri", uri: "uplay://launch/13504" }, game]]);
    });
});

describe("launch links", () => {
    it("accepts only the stores' own links with ids of the expected shape", () => {
        expect(stores.isVettedLaunchUri("steam://rungameid/730")).toBe(true);
        expect(stores.isVettedLaunchUri("steam://rungameid/730/../uninstall")).toBe(false);
        expect(stores.isVettedLaunchUri("uplay://launch/13504")).toBe(true);
        expect(stores.isVettedLaunchUri("file:///C:/Windows/System32/calc.exe")).toBe(false);
        expect(stores.isPackagedAppId("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App")).toBe(true);
        expect(stores.isPackagedAppId("..\\..\\x!y")).toBe(false);
    });

    it("keeps reading the other stores when one fails", async () => {
        const manifests = join(base, "Epic", "EpicGamesLauncher", "Data", "Manifests");
        dir(join(base, "Fortnite"));
        dir(manifests, ["A.item"]);
        file(join(manifests, "A.item"), JSON.stringify({ DisplayName: "Fortnite", AppName: "Fortnite", CatalogNamespace: "fn", CatalogItemId: "i", InstallLocation: join(base, "Fortnite") }));
        const apps = await stores.storeApps({ ProgramData: base });
        expect(apps.map((app) => app.path)).toEqual(["epic:Fortnite"]);
    });
});
