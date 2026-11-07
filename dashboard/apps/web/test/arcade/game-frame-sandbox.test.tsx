// @vitest-environment jsdom

/**
 * In a call the game runs in a sandboxed frame with an origin of its own, so the
 * browser can run it away from the page's main thread: same-origin, building the
 * city froze the call and the whole tab with it. On its own page it keeps the
 * dashboard's origin, and with it the storage that holds its settings. Its messages are known by the
 * window they come from, since its origin is opaque.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { FRAME_SANDBOX, GameFrame, fromFrame } from "../../../arcade/src/screens/game-frame";
import type { ComponentProps } from "react";
import type { GameDefinition } from "../../../arcade/src/games/types";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: { i18nProvider: { useClient: () => "browser", useLocale: () => "en-US" } }
}));
vi.mock("../../../arcade/src/screens/i18n", () => ({ useArcadeT: () => (key: string) => key }));

afterEach(() => cleanup());

const game = { id: "new-york" } as unknown as GameDefinition;
const call = {
    self: { id: "me" },
    onPlayers: () => () => {},
    onState: () => {}
} as unknown as ComponentProps<typeof GameFrame>["call"];

describe("the game's frame", () => {
    it("is sandboxed without the page's origin in a call", () => {
        render(<GameFrame game={game} call={call} />);
        const frame = document.querySelector("iframe")!;
        expect(frame.getAttribute("sandbox")).toBe(FRAME_SANDBOX);
        expect(FRAME_SANDBOX.split(" ")).toContain("allow-scripts");
        expect(FRAME_SANDBOX).not.toContain("allow-same-origin");
    });

    it("keeps the page's origin, and so its storage, on its own page", () => {
        render(<GameFrame game={game} onExit={() => {}} />);
        expect(document.querySelector("iframe")!.hasAttribute("sandbox")).toBe(false);
    });

    it("hears its page from the opaque origin, and only from its window", async () => {
        render(<GameFrame game={game} />);
        const frame = document.querySelector("iframe")!;
        const tell = (source: Window | null, origin: string) =>
            act(async () => {
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: { type: "polaris-game:failed", reason: "error" },
                        origin,
                        source
                    })
                );
            });

        await tell(window, "null");
        expect(screen.queryByRole("alert")).toBeNull();
        await tell(frame.contentWindow, "https://elsewhere.invalid");
        expect(screen.queryByRole("alert")).toBeNull();
        await tell(frame.contentWindow, "null");
        expect(screen.getByRole("alert")).toBeTruthy();
    });

    it("answers the page's hello in its window, whatever its origin", async () => {
        render(<GameFrame game={game} />);
        const frame = document.querySelector("iframe")!;
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        await act(async () => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "polaris-game:hello" },
                    origin: "null",
                    source: frame.contentWindow
                })
            );
        });
        expect(post).toHaveBeenCalledWith(
            expect.objectContaining({ type: "polaris-game:setup", locale: "en-US" }),
            "*"
        );
    });

    it("lends the game the call's controls and does what its menu asks", async () => {
        const controls = {
            micOn: true,
            toggleMic: vi.fn(),
            leaveGame: vi.fn(),
            leaveCall: vi.fn()
        };
        const view = render(<GameFrame game={game} call={{ ...call!, controls }} />);
        const frame = document.querySelector("iframe")!;
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        const tell = (data: unknown) =>
            act(async () => {
                window.dispatchEvent(
                    new MessageEvent("message", { data, origin: "null", source: frame.contentWindow })
                );
            });

        await tell({ type: "polaris-game:ready" });
        expect(post).toHaveBeenCalledWith(
            { type: "polaris-game:call", controls: true, micOn: true },
            "*"
        );
        view.rerender(<GameFrame game={game} call={{ ...call!, controls: { ...controls, micOn: false } }} />);
        expect(post).toHaveBeenLastCalledWith(
            { type: "polaris-game:call", controls: true, micOn: false },
            "*"
        );

        await tell({ type: "polaris-game:call-action", action: "mic" });
        await tell({ type: "polaris-game:call-action", action: "leave-game" });
        await tell({ type: "polaris-game:call-action", action: "leave-call" });
        await tell({ type: "polaris-game:call-action", action: "something-else" });
        expect(controls.toggleMic).toHaveBeenCalledTimes(1);
        expect(controls.leaveGame).toHaveBeenCalledTimes(1);
        expect(controls.leaveCall).toHaveBeenCalledTimes(1);
    });

    it("offers no call controls where there is no call to control", async () => {
        render(<GameFrame game={game} call={call} />);
        const frame = document.querySelector("iframe")!;
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        await act(async () => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "polaris-game:ready" },
                    origin: "null",
                    source: frame.contentWindow
                })
            );
        });
        expect(post).toHaveBeenCalledWith({ type: "polaris-game:call", controls: false }, "*");
    });

    it("tells its own messages apart from everybody else's", () => {
        const own = {} as Window;
        expect(fromFrame({ source: own, origin: "null" }, own)).toBe(true);
        expect(fromFrame({ source: own, origin: window.location.origin }, own)).toBe(true);
        expect(fromFrame({ source: own, origin: "https://elsewhere.invalid" }, own)).toBe(false);
        expect(fromFrame({ source: {} as Window, origin: "null" }, own)).toBe(false);
        expect(fromFrame({ source: own, origin: "null" }, null)).toBe(false);
    });
});
