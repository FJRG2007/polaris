// @vitest-environment jsdom

/**
 * A game room's positions go out on the reliable channel. The room publishes no
 * tracks, so its lossy channel only opens with the first send, and a player
 * whose lossy channel never opened was seen standing still all game.
 */

import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const publishData = vi.fn(async () => undefined);

vi.mock("livekit-client", () => {
    class Room {
        remoteParticipants = new Map();
        localParticipant = { publishData, setAttributes: async () => undefined };
        on() {
            return this;
        }
        async connect() {}
        async disconnect() {}
    }
    return {
        Room,
        RoomEvent: {
            ParticipantConnected: "a",
            ParticipantDisconnected: "b",
            ParticipantAttributesChanged: "c",
            DataReceived: "d",
            Disconnected: "e"
        }
    };
});

import { useLobbyRoom } from "@/app/(app)/chat/use-lobby-room";

describe("a game room's positions", () => {
    it("are sent on the reliable channel, to the other players only", async () => {
        const ticket = { url: "wss://calls.example", token: "t", seat: "me" };
        const { result } = renderHook(() => useLobbyRoom(ticket));
        await waitFor(() => expect(result.current.status).toBe("connected"));
        act(() => result.current.sendActivity(["arnau"], { kind: "pose" }));
        await waitFor(() => expect(publishData).toHaveBeenCalledTimes(1));
        expect(publishData.mock.calls[0]![1]).toMatchObject({
            reliable: true,
            destinationIdentities: ["arnau"]
        });
    });
});
