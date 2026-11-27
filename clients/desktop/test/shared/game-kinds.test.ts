/**
 * What somebody said a program is, game or application: the saved file is read
 * without trusting it, a choice that matches what the program is by itself is
 * no choice at all, and the map never grows past its cap.
 */

import { describe, expect, it } from "vitest";
import { kindAction, MAX_GAME_KINDS, readGameKinds, treatedAsGame, withGameKind, writeGameKinds } from "@/shared/game-kinds";

describe("game kinds", () => {
    it("reads back what it writes", () => {
        const kinds = new Map([["steam:367520", "app"], ["C:/menu/Emulator.lnk", "game"]] as const);
        expect([...readGameKinds(JSON.parse(JSON.stringify(writeGameKinds(kinds))))]).toEqual([...kinds]);
    });

    it("drops what it cannot read, entry by entry", () => {
        expect(readGameKinds(null).size).toBe(0);
        expect(readGameKinds({ kinds: [] }).size).toBe(0);
        const read = readGameKinds({ kinds: { "steam:1": "game", "steam:2": "boss", "": "app", [`C:/${"x".repeat(3000)}`]: "app", "epic:A": "app" } });
        expect([...read]).toEqual([["steam:1", "game"], ["epic:A", "app"]]);
    });

    it("forgets a choice that is what the program is by itself", () => {
        const chosen = withGameKind(new Map(), "steam:1", "app", "game");
        expect(chosen.get("steam:1")).toBe("app");
        expect(withGameKind(chosen, "steam:1", "game", "game").has("steam:1")).toBe(false);
        expect(withGameKind(new Map(), "C:/menu/Notepad.lnk", "app", "app").size).toBe(0);
    });

    it("keeps the newest choices when full", () => {
        let kinds = new Map<string, "game" | "app">();
        for (let index = 0; index <= MAX_GAME_KINDS; index += 1) kinds = withGameKind(kinds, `steam:${index}`, "app", "game");
        expect(kinds.size).toBe(MAX_GAME_KINDS);
        expect(kinds.has("steam:0")).toBe(false);
        expect(kinds.has(`steam:${MAX_GAME_KINDS}`)).toBe(true);
    });

    it("lets a choice win over what the launcher found, and offers the other kind", () => {
        expect(treatedAsGame(true, undefined)).toBe(true);
        expect(treatedAsGame(true, "app")).toBe(false);
        expect(treatedAsGame(false, "game")).toBe(true);
        expect(kindAction(true)).toBe("treat-as-app");
        expect(kindAction(false)).toBe("treat-as-game");
    });
});
