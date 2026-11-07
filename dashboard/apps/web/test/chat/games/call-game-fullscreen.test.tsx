// @vitest-environment jsdom

/**
 * The game's full screen button: in step with the browser however full screen
 * was entered or left (the button, Escape, the game's own menu), good for any
 * number of rounds, and handing the keyboard back to the game each time - left
 * on the button, the game's Space pressed it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    CallGameView,
    FullscreenButton,
    showsFullscreen,
    type CallActivity
} from "@/app/(app)/chat/call-activity-panel";

vi.mock("@/app/(app)/chat/call-activity-actions", () => ({}));
vi.mock("@/components/app-extensions/installed-client", () => ({ AppSlotView: () => null }));
vi.mock("@/components/avatar", () => ({ Avatar: () => null }));
vi.mock("@/components/i18n/i18n-provider", () => ({ useTranslations: () => (key: string) => key }));

let current: Element | null = null;

beforeEach(() => {
    current = null;
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => current
    });
    document.exitFullscreen = vi.fn(async () => change(null));
});

afterEach(() => {
    cleanup();
    document.body.replaceChildren();
});

/** The browser entering or leaving full screen, by whatever way. */
function change(element: Element | null) {
    current = element;
    document.dispatchEvent(new Event("fullscreenchange"));
}

function mount() {
    const target = document.createElement("section");
    const frame = document.createElement("iframe");
    target.append(frame);
    document.body.append(target);
    target.requestFullscreen = vi.fn(async () => change(target));
    render(<FullscreenButton target={target} />);
    return { target, frame, button: () => screen.getByRole("button") };
}

describe("whether the game is full screen", () => {
    it("counts the game's own frame going full screen from inside", () => {
        const { target, frame } = mount();
        expect(showsFullscreen(target, target)).toBe(true);
        expect(showsFullscreen(target, frame)).toBe(true);
        expect(showsFullscreen(target, document.body)).toBe(false);
        expect(showsFullscreen(target, null)).toBe(false);
        expect(showsFullscreen(null, target)).toBe(false);
    });
});

describe("the full screen button", () => {
    it("goes in and out, again and again, and gives the game the keyboard", async () => {
        const { target, frame, button } = mount();
        for (let round = 0; round < 3; round++) {
            await act(async () => fireEvent.click(button()));
            expect(button().getAttribute("aria-pressed")).toBe("true");
            expect(document.activeElement).toBe(frame);

            await act(async () => fireEvent.click(button()));
            expect(button().getAttribute("aria-pressed")).toBe("false");
            expect(document.activeElement).toBe(frame);
        }
        expect(target.requestFullscreen).toHaveBeenCalledTimes(3);
        expect(document.exitFullscreen).toHaveBeenCalledTimes(3);
    });

    it("follows Escape, which the browser handles without the button", async () => {
        const { target, button } = mount();
        await act(async () => fireEvent.click(button()));
        expect(button().getAttribute("aria-pressed")).toBe("true");

        act(() => change(null));
        expect(button().getAttribute("aria-pressed")).toBe("false");
        await act(async () => fireEvent.click(button()));
        expect(target.requestFullscreen).toHaveBeenCalledTimes(2);
    });

    it("is a way out when the game went full screen from its own menu", async () => {
        const { target, frame, button } = mount();
        act(() => change(frame));
        expect(button().getAttribute("aria-pressed")).toBe("true");

        await act(async () => fireEvent.click(button()));
        expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
        expect(target.requestFullscreen).not.toHaveBeenCalled();
    });

    it("is not drawn where the browser has no full screen", () => {
        Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
        mount();
        expect(screen.queryByRole("button")).toBeNull();
    });
});

describe("the game on the call's stage", () => {
    const activity = {
        session: { game: "new-york", players: ["me"], startedBy: "me" },
        playing: true,
        host: {
            self: { id: "me", name: "Me" },
            onPlayers: () => () => undefined,
            onState: () => undefined
        },
        answer: {
            ok: true,
            seat: "me",
            games: [{ id: "new-york", name: "New York", slot: { bundle: "x" } }]
        },
        focused: false,
        setFocused: () => undefined,
        gameName: () => "New York",
        nameOf: () => "Me",
        leave: () => undefined
    } as unknown as CallActivity;

    it("asks the call for the stage, the way a screen does", () => {
        const onFocus = vi.fn();
        render(<CallGameView activity={activity} focused={false} onFocus={onFocus} />);
        fireEvent.click(screen.getByRole("button", { name: "callGames.focus" }));
        expect(onFocus).toHaveBeenCalledTimes(1);
    });

    it("cannot be reached while it runs out of sight", () => {
        const { container, rerender } = render(<CallGameView activity={activity} away />);
        expect(container.querySelector("section")!.hasAttribute("inert")).toBe(true);
        rerender(<CallGameView activity={activity} />);
        expect(container.querySelector("section")!.hasAttribute("inert")).toBe(false);
    });
});
