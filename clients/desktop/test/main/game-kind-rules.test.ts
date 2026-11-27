/**
 * The launcher's "Treat as Game" / "Treat as Application" choices as the game
 * watcher reads them: a program treated as a game is reported by its listed
 * name and puts a game in front; one treated as an application is never a
 * game, nor what pauses the launcher's key, even full screen; a store game
 * treated as an application takes its folder with it, but never a folder that
 * holds many games.
 */

import { describe, expect, it } from "vitest";
import { GameWatcher, gameKindRules, withoutApplications, type ListedProgram, type RunningGame, type Seen } from "@/main/game-detect";

const EMULATOR: ListedProgram = { label: "Dolphin", path: "C:\\menu\\Dolphin.lnk", target: "C:\\Tools\\Dolphin\\Dolphin.exe" };
const HOLLOW: ListedProgram = { label: "Hollow Knight", path: "steam:367520", launch: { kind: "uri" }, folder: "D:\\SteamLibrary\\steamapps\\common\\Hollow Knight" };
const VIEWER: ListedProgram = { label: "Viewer", path: "C:\\menu\\Viewer.lnk", launch: { kind: "exe", path: "C:\\Tools\\Viewer\\viewer.exe" } };

function watcher(list: readonly Seen[], kinds: ReadonlyMap<string, "game" | "app">, games = [{ name: "Hollow Knight", folder: HOLLOW.folder!, store: "steam:367520" }]) {
    const said: (RunningGame | null)[] = [];
    const fronts: boolean[] = [];
    const watch = new GameWatcher((game) => said.push(game), async () => list, () => games, "C:\\Polaris\\Polaris.exe");
    watch.onForeground((busy) => fronts.push(busy));
    watch.setKindRules(() => gameKindRules([EMULATOR, HOLLOW, VIEWER], kinds));
    return { watch, said, fronts };
}

describe("game kind rules", () => {
    it("makes nothing of no choices, or of choices for programs no longer listed", () => {
        expect(gameKindRules([EMULATOR], new Map())).toEqual({ games: [], notPrograms: new Set(), notFolders: [] });
        expect(gameKindRules([EMULATOR], new Map([["steam:1", "app"]]))).toEqual({ games: [], notPrograms: new Set(), notFolders: [] });
    });

    it("knows a program treated as a game by its own file and listed name", () => {
        expect(gameKindRules([EMULATOR, VIEWER], new Map([[EMULATOR.path, "game"], [VIEWER.path, "game"]])).games).toEqual([
            { executable: "dolphin.exe", name: "Dolphin" },
            { executable: "viewer.exe", name: "Viewer" }
        ]);
    });

    it("never lets an application's folder be a drive or a library", () => {
        const library: ListedProgram = { label: "Odd", path: "steam:9", folder: "D:\\SteamLibrary\\steamapps\\common" };
        expect(gameKindRules([library], new Map([[library.path, "app"]])).notFolders).toEqual([]);
    });

    it("drops what is treated as an application from the programs counted", () => {
        const rules = gameKindRules([HOLLOW, VIEWER], new Map([[HOLLOW.path, "app"], [VIEWER.path, "app"]]));
        const kept = withoutApplications(
            [{ name: "viewer.exe" }, { name: "hollow_knight.exe", path: `${HOLLOW.folder}\\hollow_knight.exe` }, { name: "code.exe", path: "C:\\Code\\code.exe" }],
            rules
        );
        expect(kept.map((entry) => entry.name)).toEqual(["code.exe"]);
    });

    it("reports a program treated as a game, and counts it in front", async () => {
        const { watch, said, fronts } = watcher([{ name: "dolphin.exe", path: EMULATOR.target!, foreground: "window" }], new Map([[EMULATOR.path, "game"]]));
        await watch.check(0);
        expect(said.at(-1)).toMatchObject({ key: "dolphin.exe", name: "Dolphin" });
        expect(fronts).toEqual([true]);
    });

    it("never reports a store game treated as an application, nor pauses for it full screen", async () => {
        const running = [{ name: "hollow_knight.exe", path: `${HOLLOW.folder}\\hollow_knight.exe`, foreground: "fullscreen" as const }];
        const automatic = watcher(running, new Map());
        await automatic.watch.check(0);
        expect(automatic.said.at(-1)).toMatchObject({ name: "Hollow Knight", store: "steam:367520" });
        expect(automatic.fronts).toEqual([true]);

        const chosen = watcher(running, new Map([[HOLLOW.path, "app"]]));
        await chosen.watch.check(0);
        expect(chosen.said).toEqual([null]);
        expect(chosen.fronts).toEqual([]);
        expect(chosen.watch.gameInFront()).toBe(false);
    });
});
