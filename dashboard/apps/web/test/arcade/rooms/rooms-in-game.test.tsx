// @vitest-environment jsdom

/**
 * Rooms live inside each game, not in the library: the library's cards say only
 * that a game has rooms and how many public ones are open, a game whose
 * definition declares rooms offers them on its own page scoped to its id (off,
 * with the reason, for somebody an admin turned it off for), and a game that
 * declares none shows nothing of them.
 */

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const seen = vi.hoisted(() => ({ frame: null as null | Record<string, unknown> }));

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        i18nProvider: { useClient: () => "browser", useLocale: () => "en-US" },
        arcadeRooms: {
            GameRooms: ({ game }: { game: { id: string } }) => (
                <div data-testid="rooms">{game.id}</div>
            ),
            publicRoomCounts: async () => ({ ok: true, counts: { "new-york": 3 } })
        },
        arcadeInvite: {
            GameInviteDialog: () => null,
            gameInviteAccess: async () => ({ ok: true })
        }
    }
}));
vi.mock("../../../../arcade/src/screens/i18n", () => ({
    useArcadeT: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("next/link", () => ({
    default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    )
}));
vi.mock("../../../../arcade/src/screens/game-cover", () => ({ GameCover: () => null }));
vi.mock("../../../../arcade/src/screens/game-frame", () => ({
    GameFrame: (props: Record<string, unknown>) => {
        seen.frame = props;
        return (
            <button type="button" onClick={() => (props.onRooms as (() => void) | undefined)?.()}>
                start-screen-together
            </button>
        );
    }
}));
vi.mock("../../../../arcade/src/games/registry", async () => {
    const { Building2, Puzzle } = await import("lucide-react");
    const GAMES = [
        { id: "new-york", icon: Building2, multiplayer: true, rooms: { maxPlayers: 32 } },
        { id: "fixture-solo", icon: Puzzle, multiplayer: false }
    ];
    return {
        GAMES,
        findGame: (id: string) => GAMES.find((game) => game.id === id) ?? null,
        gameFrameSrc: () => "/x",
        gameCoverSrc: () => null
    };
});

import { GamesScreen } from "../../../../arcade/src/screens/library";
import { GamePlayer } from "../../../../arcade/src/screens/game-player";

afterEach(() => {
    cleanup();
    seen.frame = null;
});

describe("the library", () => {
    it("has no rooms of its own: a badge and the open count on the card, and the phone controller", async () => {
        await act(async () => {
            render(<GamesScreen together />);
        });
        expect(screen.queryByText("together")).toBeNull();
        expect(screen.queryByTestId("rooms")).toBeNull();
        expect(screen.getAllByText("multiplayerBadge")).toHaveLength(1);
        expect(screen.getByText('openRooms {"count":3}')).toBeTruthy();
        expect(screen.getByText("phonePad").closest("a")?.getAttribute("href")).toBe("/games/pad");
    });

    it("shows no open count to somebody who may not play with others", async () => {
        await act(async () => {
            render(<GamesScreen together={false} />);
        });
        expect(screen.queryByText(/openRooms/)).toBeNull();
        expect(screen.queryByText("togetherDenied")).toBeNull();
    });
});

describe("a game's own page", () => {
    it("offers the rooms of a game that declares them, scoped to its id, from the bar and the start screen", async () => {
        await act(async () => {
            render(<GamePlayer gameId="new-york" together />);
        });
        expect(seen.frame?.rooms).toBe("on");
        fireEvent.click(screen.getByLabelText("together"));
        expect(screen.getByTestId("rooms").textContent).toBe("new-york");
        cleanup();

        await act(async () => {
            render(<GamePlayer gameId="new-york" together />);
        });
        fireEvent.click(screen.getByText("start-screen-together"));
        expect(screen.getByTestId("rooms").textContent).toBe("new-york");
    });

    it("shows them off with the reason when an admin turned playing with others off", async () => {
        await act(async () => {
            render(<GamePlayer gameId="new-york" together={false} />);
        });
        const button = screen.getByLabelText("together") as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.title).toBe("togetherDenied");
        expect(seen.frame?.rooms).toBe("denied");
        fireEvent.click(screen.getByText("start-screen-together"));
        expect(screen.queryByTestId("rooms")).toBeNull();
    });

    it("shows nothing of rooms for a game that declares none", async () => {
        await act(async () => {
            render(<GamePlayer gameId="fixture-solo" together />);
        });
        expect(screen.queryByLabelText("together")).toBeNull();
        expect(seen.frame?.rooms).toBe("off");
        expect(seen.frame?.onRooms).toBeUndefined();
    });
});
