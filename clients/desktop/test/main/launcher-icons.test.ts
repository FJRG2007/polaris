/**
 * Every row the launcher lists is drawn with a real picture when its source
 * has one: a shortcut by the icon it names or its target (never the `.lnk`
 * itself, which the shell draws with the generic shortcut picture), an
 * Internet shortcut by its `IconFile`, a packaged app by its manifest's logo,
 * a store game by its executable. Pure functions; no file is read.
 */

import { describe, expect, it } from "vitest";
import * as icons from "../../src/main/launcher-icons";
import * as programs from "../../src/main/launcher-programs";

const env = { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" } as NodeJS.ProcessEnv;

describe("shortcuts", () => {
    it("takes the icon a shortcut names, expanded, without its index", () => {
        expect(icons.shortcutIcon({ icon: "%ProgramFiles%\\Mozilla Firefox\\firefox.exe", target: "C:\\x\\other.exe" }, env)).toBe("C:\\Program Files\\Mozilla Firefox\\firefox.exe");
        expect(icons.shortcutIcon({ icon: "\"C:\\Apps\\tool.ico\",0" }, env)).toBe("C:\\Apps\\tool.ico");
    });

    it("falls back to the shortcut's program, and gives nothing for a variable it cannot expand", () => {
        expect(icons.shortcutIcon({ icon: "", target: "C:\\Games\\Game\\game.exe" }, env)).toBe("C:\\Games\\Game\\game.exe");
        expect(icons.shortcutIcon({ icon: "%Unknown%\\a.ico" }, env)).toBeNull();
        expect(icons.shortcutIcon({ target: "C:\\docs\\readme.txt" }, env)).toBeNull();
    });

    it("reads an Internet shortcut's IconFile, as Steam writes it", () => {
        const url = "[{000214A0-0000-0000-C000-000000000046}]\r\nProp3=19,0\r\n[InternetShortcut]\r\nIDList=\r\nIconIndex=0\r\nURL=steam://rungameid/1145360\r\nIconFile=C:\\Program Files (x86)\\Steam\\steam\\games\\abc.ico\r\n";
        expect(icons.urlShortcutIcon(url, env)).toBe("C:\\Program Files (x86)\\Steam\\steam\\games\\abc.ico");
        expect(icons.urlShortcutIcon("[InternetShortcut]\r\nURL=https://example.com\r\n", env)).toBeNull();
    });

    it("never draws a row from a .lnk or .url itself", () => {
        expect(icons.iconCandidates({ path: "C:\\Start\\Game.lnk" }, "win32")).toEqual([]);
        expect(icons.iconCandidates({ path: "C:\\Start\\Game.url", icon: "C:\\s\\games\\a.ico" }, "win32")).toEqual(["C:\\s\\games\\a.ico"]);
        expect(icons.iconCandidates({ path: "C:\\Start\\App.lnk", target: "C:\\App\\app.exe" }, "win32")).toEqual(["C:\\App\\app.exe"]);
        expect(icons.iconCandidates({ path: "/Applications/Notes.app" }, "darwin")).toEqual(["/Applications/Notes.app"]);
    });
});

describe("packaged apps", () => {
    const manifest = [
        "<Package><Properties><Logo>Assets\\StoreLogo.png</Logo></Properties><Applications>",
        "<Application Id=\"Other\"><uap:VisualElements Square44x44Logo=\"Assets\\Other.png\" /></Application>",
        "<Application Id=\"App\"><uap:VisualElements Square150x150Logo=\"Assets\\Med.png\" Square44x44Logo=\"Images/Small.png\" /></Application>",
        "</Applications></Package>"
    ].join("");

    it("reads the logo of the app asked for, not the package's first", () => {
        expect(icons.manifestLogo(manifest, "App")).toBe("Images\\Small.png");
        expect(icons.manifestLogo(manifest, "Other")).toBe("Assets\\Other.png");
    });

    it("falls back to the package logo, and never to a resource or a path outside the package", () => {
        expect(icons.manifestLogo(manifest, "Missing")).toBe("Assets\\StoreLogo.png");
        expect(icons.manifestLogo("<Package><Application Id=\"App\"><VisualElements Square44x44Logo=\"ms-resource:Logo\" /></Application></Package>", "App")).toBeNull();
        expect(icons.manifestLogo("<Package><Application Id=\"App\"><VisualElements Square44x44Logo=\"..\\..\\x.png\" /></Application></Package>", "App")).toBeNull();
    });

    it("picks the variant Windows draws small: unplated 32 px, then any size, then the plainest scale", () => {
        expect(icons.pickAsset("Assets\\Logo.png", ["Logo.scale-200.png", "Logo.targetsize-48.png", "Logo.targetsize-32.png", "Logo.targetsize-32_altform-unplated.png"])).toBe("Logo.targetsize-32_altform-unplated.png");
        expect(icons.pickAsset("Assets\\Logo.png", ["Logo.scale-400.png", "Logo.scale-100.png", "Logo.contrast-white_scale-100.png"])).toBe("Logo.scale-100.png");
        expect(icons.pickAsset("Assets\\Logo.png", ["Logo.targetsize-16.png", "Logo.targetsize-256.png"])).toBe("Logo.targetsize-256.png");
        expect(icons.pickAsset("Assets\\Logo.png", ["Logo.png", "Logo.scale-100.png"])).toBe("Logo.png");
        expect(icons.pickAsset("Assets\\Logo.png", ["Other.png"])).toBeNull();
    });
});

describe("store games", () => {
    it("finds Steam's hashed icon among the per-game cache files", () => {
        expect(icons.steamFolderIcon(["header.jpg", "logo.png", "ABCDEFabcdef0123456789abcdef0123456789ab.jpg"])).toBe("ABCDEFabcdef0123456789abcdef0123456789ab.jpg");
        expect(icons.steamFolderIcon(["header.jpg", "library_600x900.jpg"])).toBeNull();
        expect(icons.steamUninstallId("HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 730")).toBe("730");
    });

    it("draws a game with no picture of its own by the executable most like its name", () => {
        const dir = "C:\\Games\\Assassin's Creed Mirage";
        const exes = ["unins000.exe", "UbisoftConnectInstaller.exe", "ACMirage.exe", "ACMirage_plugin_helper.exe", "CrashReporter.exe"].map((name) => `${dir}\\${name}`);
        expect(icons.gameExe("Assassin's Creed Mirage", exes)).toBe(`${dir}\\ACMirage.exe`);
        expect(icons.gameExe("Hades", ["C:\\G\\Hades\\Hades.exe", "C:\\G\\Hades\\EasyAntiCheat_Setup.exe"])).toBe("C:\\G\\Hades\\Hades.exe");
        expect(icons.gameExe("Anything", ["C:\\G\\unins000.exe"])).toBeNull();
    });
});

describe("merging copies", () => {
    it("keeps the first copy to open by, with the picture a later copy has", () => {
        const merged = programs.mergePrograms<programs.FoundProgram>(
            [
                [{ label: "Hades", path: "C:\\Start\\Hades.url", target: "steam://rungameid/1145360" }],
                [{ label: "Hades", path: "steam:1145360", launch: { kind: "uri", uri: "steam://rungameid/1145360" }, icon: "C:\\Steam\\steam\\games\\a.ico" }]
            ],
            10
        );
        expect(merged).toEqual([{ label: "Hades", path: "C:\\Start\\Hades.url", target: "steam://rungameid/1145360", icon: "C:\\Steam\\steam\\games\\a.ico", aliases: [] }]);
    });
});
