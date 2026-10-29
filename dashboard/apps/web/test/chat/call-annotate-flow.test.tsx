// @vitest-environment jsdom

/**
 * Asking to draw on somebody's screen, from both ends: the viewer's pen asks,
 * the sharer's strip allows, and the sharer's attribute is what says who can.
 */

import type { ReactNode } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallState, PeerState } from "@/app/(app)/chat/call-state";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnnotateButton, AnnotateProvider, AnnotateStrip } from "@/app/(app)/chat/call-annotate";

afterEach(cleanup);

function fakeCall(overrides: Partial<CallState>) {
    let heard: ((from: string, raw: unknown) => void) | null = null;
    const call = {
        participantId: "me",
        sharing: false,
        states: new Map<string, PeerState>(),
        meeting: { participants: [{ id: "viewer", name: "Ana" }] },
        setAnnotators: vi.fn(),
        sendAnnotate: vi.fn(),
        listenAnnotate: (listener: (from: string, raw: unknown) => void) => {
            heard = listener;
            return () => {
                heard = null;
            };
        },
        ...overrides
    } as unknown as CallState;
    return { call, hear: (from: string, raw: unknown) => act(() => heard?.(from, raw)) };
}

const wrap = (call: CallState, children: ReactNode) => (
    <MessagesWrapper>
        <AnnotateProvider call={call}>{children}</AnnotateProvider>
    </MessagesWrapper>
);

describe("drawing on a share", () => {
    it("asks the sharer from the pen on their screen", () => {
        const { call } = fakeCall({});
        render(wrap(call, <AnnotateButton owner="presenter" />));
        fireEvent.click(screen.getByRole("button", { name: "Ask to draw on this screen" }));
        expect(call.sendAnnotate).toHaveBeenCalledWith(["presenter"], { kind: "draw-ask" });
        expect(screen.getByRole("button", { name: "Asked to draw" })).toHaveProperty(
            "disabled",
            true
        );
    });

    it("offers the pen once the sharer's attribute names this seat", () => {
        const states = new Map<string, PeerState>([
            ["presenter", { annotators: ["me"] } as unknown as PeerState]
        ]);
        const { call } = fakeCall({ states });
        render(wrap(call, <AnnotateButton owner="presenter" />));
        fireEvent.click(screen.getByRole("button", { name: "Draw on this screen" }));
        expect(screen.getByRole("button", { name: "Put the pen down" })).toBeTruthy();
    });

    it("lets the sharer allow a request, and says so in their attribute", () => {
        const { call, hear } = fakeCall({ sharing: true });
        render(wrap(call, <AnnotateStrip />));
        hear("viewer", { kind: "draw-ask" });
        expect(screen.getByText(/Ana wants to draw on your screen/)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Allow" }));
        expect(call.setAnnotators).toHaveBeenLastCalledWith("viewer");
        expect(call.sendAnnotate).toHaveBeenCalledWith(["viewer"], {
            kind: "draw-answer",
            allowed: true
        });
        fireEvent.click(screen.getByRole("button", { name: "Stop drawing" }));
        expect(call.setAnnotators).toHaveBeenLastCalledWith("");
    });

    it("ignores a request while nothing is being shared", () => {
        const { call, hear } = fakeCall({ sharing: false });
        render(wrap(call, <AnnotateStrip />));
        hear("viewer", { kind: "draw-ask" });
        expect(screen.queryByText(/wants to draw/)).toBeNull();
    });
});
