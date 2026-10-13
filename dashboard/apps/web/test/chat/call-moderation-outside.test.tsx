// @vitest-environment jsdom

/**
 * A moderator acts on a call without joining it.
 *
 * The faces a conversation shows of a call the reader is not in take the same
 * right-click the call itself does: mute, deafen and disconnect. Nobody else
 * gets the menu, and the reader never gets it over their own face.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const moderateCallAction = vi.fn(async (_input: unknown) => ({}));

vi.mock("@/app/(app)/chat/meeting-actions", () => ({ moderateCallAction }));

const { SeatMenu } = await import("@/app/(app)/chat/call-moderation-menu");

afterEach(() => {
    cleanup();
    moderateCallAction.mockClear();
});

const seat = {
    id: "seat-1",
    userId: "member",
    name: "Fixture Member",
    serverMuted: false,
    serverDeafened: false
};

function draw(moderation?: { moderates: boolean; viewerId: string; onDone?: () => void }, person = seat) {
    render(
        <SeatMenu person={person} moderation={moderation}>
            <button type="button">face</button>
        </SeatMenu>,
        { wrapper: MessagesWrapper }
    );
    fireEvent.contextMenu(screen.getByText("face"));
}

describe("a moderator's right-click on somebody in a call they are not in", () => {
    it("disconnects them by their seat, and redraws the faces", async () => {
        const onDone = vi.fn();
        draw({ moderates: true, viewerId: "owner", onDone });
        fireEvent.click(screen.getByText("Disconnect"));
        await waitFor(() => expect(onDone).toHaveBeenCalled());
        expect(moderateCallAction).toHaveBeenCalledWith({ participantId: "seat-1", action: "disconnect" });
    });

    it("offers mute and deafen as well", () => {
        draw({ moderates: true, viewerId: "owner" });
        expect(screen.getByText("Server mute")).toBeTruthy();
        expect(screen.getByText("Disconnect")).toBeTruthy();
    });

    it("is not offered to somebody who does not moderate", () => {
        draw({ moderates: false, viewerId: "owner" });
        expect(screen.queryByText("Disconnect")).toBeNull();
    });

    it("is not offered over the reader's own face", () => {
        draw({ moderates: true, viewerId: "member" });
        expect(screen.queryByText("Disconnect")).toBeNull();
    });

    it("is not offered where no moderation was passed", () => {
        draw();
        expect(screen.queryByText("Disconnect")).toBeNull();
    });
});
