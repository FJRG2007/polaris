/**
 * The Games library's rooms screen: the forms are there before the list
 * answers, only the list waits behind a skeleton, an empty list says what to
 * do, a code is only called wrong once it is whole, and a refusal is a
 * sentence rather than a dead button.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({
    list: null as null | ((value: unknown) => void),
    joined: [] as unknown[],
    pushed: [] as string[],
    join: async (input: unknown): Promise<unknown> => {
        api.joined.push(input);
        return { ok: false, reason: "unknown" };
    }
}));

vi.mock("@/app/(app)/chat/room-actions", () => ({
    publicGameRooms: () =>
        new Promise((resolve) => {
            api.list = resolve;
        }),
    createGameRoom: async () => ({ ok: true, href: "/chat/play/room" }),
    joinGameRoom: (input: unknown) => api.join(input)
}));
vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => (key: string) => key
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: (href: string) => api.pushed.push(href) })
}));
vi.mock("@/lib/snapshot-cache", () => ({
    readSnapshot: () => null,
    writeSnapshot: () => undefined
}));

import { GameRooms } from "@/components/arcade/game-rooms";

const GAMES = [{ id: "new-york", name: "Skyline Roam" }];

beforeEach(() => {
    api.list = null;
    api.joined = [];
    api.pushed = [];
});
afterEach(cleanup);

describe("GameRooms", () => {
    it("draws the forms at once and a skeleton only where the list goes", () => {
        render(<GameRooms games={GAMES} />);
        expect(screen.getByText("gameRooms.create")).toBeTruthy();
        expect(screen.getByLabelText("gameRooms.code")).toBeTruthy();
        expect(screen.getByText("gameRooms.publicRooms")).toBeTruthy();
        expect(document.querySelector("[aria-busy]")).not.toBeNull();
    });

    it("says there are no public rooms, and lists the ones there are", async () => {
        const { unmount } = render(<GameRooms games={GAMES} />);
        await act(async () => api.list!({ ok: true, rooms: [] }));
        expect(screen.getByText("gameRooms.empty")).toBeTruthy();
        unmount();

        render(<GameRooms games={GAMES} />);
        await act(async () =>
            api.list!({
                ok: true,
                rooms: [
                    {
                        id: "room",
                        game: "new-york",
                        gameName: "Skyline Roam",
                        host: { id: "host", name: "Fixture Host" },
                        players: 2,
                        max: 8,
                        href: "/chat/play/room"
                    }
                ]
            })
        );
        expect(screen.getByText("Skyline Roam")).toBeTruthy();
        expect(screen.getByText("gameRooms.joinRoom").closest("a")?.getAttribute("href")).toBe(
            "/chat/play/room"
        );
    });

    it("turns a refused list into its sentence", async () => {
        render(<GameRooms games={GAMES} />);
        await act(async () => api.list!({ ok: false, reason: "denied" }));
        expect(screen.getByText("gameRooms.refused.denied")).toBeTruthy();
    });

    it("calls a code wrong only once it is whole, and shows why a join was refused", async () => {
        render(<GameRooms games={GAMES} />);
        const input = screen.getByLabelText("gameRooms.code");
        fireEvent.change(input, { target: { value: "abc" } });
        expect(screen.queryByText("gameRooms.codeInvalid")).toBeNull();
        fireEvent.click(screen.getByText("gameRooms.join"));
        expect(api.joined).toEqual([]);

        fireEvent.change(input, { target: { value: "UUUU-UUUU" } });
        expect(screen.getByText("gameRooms.codeInvalid")).toBeTruthy();

        fireEvent.change(input, { target: { value: "abcd-2345" } });
        await act(async () => {
            fireEvent.click(screen.getByText("gameRooms.join"));
        });
        expect(api.joined).toEqual([{ code: "abcd-2345" }]);
        expect(screen.getByText("gameRooms.refused.unknown")).toBeTruthy();
    });

    it("creates a room and goes to it", async () => {
        render(<GameRooms games={GAMES} />);
        await act(async () => {
            fireEvent.click(screen.getByText("gameRooms.create"));
        });
        expect(api.pushed).toEqual(["/chat/play/room"]);
    });
});
