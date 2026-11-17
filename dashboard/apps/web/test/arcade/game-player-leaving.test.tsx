// @vitest-environment jsdom

/**
 * Ctrl+W and Ctrl+Shift+W belong to the browser, so a game open in the player
 * asks before the tab or window closes, and stops asking once it is closed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        arcadeRooms: { GameRooms: () => null },
        arcadeInvite: { GameInviteDialog: () => null, gameInviteAccess: async () => ({ ok: true }) }
    }
}));
vi.mock("../../../arcade/src/screens/i18n", () => ({ useArcadeT: () => (key: string) => key }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("../../../arcade/src/screens/game-frame", () => ({ GameFrame: () => null }));
vi.mock("../../../arcade/src/games/registry", async () => {
    const { Puzzle } = await import("lucide-react");
    const GAMES = [{ id: "fixture-solo", icon: Puzzle, multiplayer: false }];
    return { GAMES, findGame: (id: string) => GAMES.find((game) => game.id === id) ?? null };
});

import { GamePlayer } from "../../../arcade/src/screens/game-player";

const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
};

afterEach(cleanup);

describe("a game in the player", () => {
    it("asks before the tab closes while it is open, and not after", () => {
        const { unmount } = render(<GamePlayer gameId="fixture-solo" together={false} />);
        expect(unload()).toBe(true);
        unmount();
        expect(unload()).toBe(false);
    });
});
