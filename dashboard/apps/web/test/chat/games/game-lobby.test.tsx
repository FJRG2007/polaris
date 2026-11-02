// @vitest-environment jsdom

/**
 * A lobby whose first requests get no answer: nothing would ever claim the seat
 * again, so the page has to say so and offer another try instead of pulsing on
 * "checking" for as long as the reader waits.
 */

import * as callGame from "@/lib/chat/call-activity";
import { GameLobby } from "@/app/(app)/chat/game-lobby";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
    enterLobby: vi.fn(),
    lobbyGames: vi.fn(),
    claimLobbyGame: vi.fn(),
    renewLobbyGame: vi.fn(),
    leaveLobbyGame: vi.fn(),
    vouchLobbyGames: vi.fn()
}));

vi.mock("@/app/(app)/chat/lobby-actions", () => api);
vi.mock("@/app/(app)/chat/call-activity-actions", () => ({}));
vi.mock("@/components/app-extensions/installed-client", () => ({ AppSlotView: () => null }));
vi.mock("@/components/avatar", () => ({ Avatar: () => null }));
vi.mock("@/components/arcade/game-invite-dialog", () => ({ GameInviteDialog: () => null }));
vi.mock("@/components/i18n/i18n-provider", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/app/(app)/chat/use-lobby-room", () => {
    const room = {
        status: "connected",
        participantId: "me",
        states: new Map(),
        meeting: { participants: [{ id: "me", name: "Me" }] },
        setActivity: () => undefined,
        sendActivity: () => undefined,
        listenActivity: () => () => undefined
    };
    return { useLobbyRoom: () => room };
});

const SESSION = "11111111-1111-4111-8111-111111111111";
const GAME = {
    id: "new-york",
    name: "New York",
    slot: { app: "arcade", slot: "call-activity", bundle: "x", props: {} }
};
const allowed = { ok: true, seat: "me", games: [GAME] };
const claim = () => ({
    claim: { game: "new-york", at: 1, pass: `${Date.now() + callGame.PASS_TTL_MS}.sig` }
});

beforeEach(() => {
    vi.resetAllMocks();
    api.enterLobby.mockResolvedValue({
        ok: true,
        url: "wss://media.invalid",
        token: "fixture-token",
        seat: "me",
        game: "new-york",
        channelId: "channel",
        member: true
    });
    api.leaveLobbyGame.mockResolvedValue(undefined);
    api.vouchLobbyGames.mockResolvedValue({ seats: [], now: Date.now() });
});
afterEach(cleanup);

describe("a lobby whose request got no answer", () => {
    it("offers another try when the claim is lost, and claims again", async () => {
        api.lobbyGames.mockResolvedValue(allowed);
        api.claimLobbyGame.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(claim());
        render(<GameLobby sessionId={SESSION} />);

        const retry = await screen.findByRole("button", { name: "lobby.retry" });
        expect(screen.getByRole("alert").textContent).toContain("lobby.refused.server");
        expect(api.claimLobbyGame).toHaveBeenCalledTimes(1);

        await act(async () => fireEvent.click(retry));
        await waitFor(() => expect(api.claimLobbyGame).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });

    it("offers another try when the question is lost, and then claims", async () => {
        api.lobbyGames.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(allowed);
        api.claimLobbyGame.mockResolvedValue(claim());
        render(<GameLobby sessionId={SESSION} />);

        const retry = await screen.findByRole("button", { name: "lobby.retry" });
        expect(api.claimLobbyGame).not.toHaveBeenCalled();

        await act(async () => fireEvent.click(retry));
        await waitFor(() => expect(api.claimLobbyGame).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });

    it("offers no try on a refusal the server answered", async () => {
        api.lobbyGames.mockResolvedValue({ ok: false, reason: "denied" });
        render(<GameLobby sessionId={SESSION} />);

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain("lobby.refused.denied");
        expect(screen.queryByRole("button", { name: "lobby.retry" })).toBeNull();
    });
});
