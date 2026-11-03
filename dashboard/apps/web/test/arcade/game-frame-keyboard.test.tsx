// @vitest-environment jsdom

/**
 * The frame taking the keyboard: without it the car ignored WASD until something
 * in the game was clicked. A button left holding the focus gives it up; a field,
 * an open dialog, a menu or a list keeps it, because the reader is using them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GameFrame } from "../../../arcade/src/screens/game-frame";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { GameDefinition } from "../../../arcade/src/games/types";
import { isDrivingKey, mayTakeFocus } from "../../../arcade/src/screens/frame-focus";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: { i18nProvider: { useClient: () => "browser", useLocale: () => "en-US" } }
}));
vi.mock("../../../arcade/src/screens/i18n", () => ({ useArcadeT: () => (key: string) => key }));

afterEach(() => {
    cleanup();
    document.body.replaceChildren();
});

function mount(html: string, selector: string): Element {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    document.body.append(holder);
    return holder.querySelector(selector)!;
}

describe("whether the frame may take the keyboard", () => {
    it("takes it when nothing on the page has it", () => {
        expect(mayTakeFocus(null)).toBe(true);
        expect(mayTakeFocus(document.body)).toBe(true);
        expect(mayTakeFocus(document.documentElement)).toBe(true);
    });

    it.each([
        ["<iframe></iframe>", "iframe"],
        ["<button>Join</button>", "button"],
        ['<a href="#x">Link</a>', "a"]
    ])("takes it from %s", (html, selector) => {
        expect(mayTakeFocus(mount(html, selector))).toBe(true);
    });

    it.each([
        ["<input />", "input"],
        ["<textarea></textarea>", "textarea"],
        ["<select></select>", "select"],
        ['<div contenteditable="true"></div>', "div"],
        ['<div contenteditable=""></div>', "div"]
    ])("never takes it from the field %s", (html, selector) => {
        expect(mayTakeFocus(mount(html, selector))).toBe(false);
    });

    it.each([
        ['<div role="dialog"></div>', "[role]"],
        ['<div role="dialog"><button>Close</button></div>', "button"],
        ['<div role="alertdialog"><button>Delete</button></div>', "button"],
        ['<div role="menu"></div>', "[role]"],
        ['<div role="menu"><div role="menuitem"></div></div>', "[role='menuitem']"],
        ['<div role="listbox"><div role="option"></div></div>', "[role='option']"]
    ])("never takes it from %s", (html, selector) => {
        expect(mayTakeFocus(mount(html, selector))).toBe(false);
    });
});

describe("driving keys", () => {
    const key = (code: string, extra = {}) => ({
        code,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        defaultPrevented: false,
        ...extra
    });

    it("reads them, and leaves shortcuts and handled keys to the page", () => {
        expect(isDrivingKey(key("KeyW"))).toBe(true);
        expect(isDrivingKey(key("ArrowLeft"))).toBe(true);
        expect(isDrivingKey(key("KeyM"))).toBe(false);
        expect(isDrivingKey(key("KeyS", { ctrlKey: true }))).toBe(false);
        expect(isDrivingKey(key("ArrowUp", { defaultPrevented: true }))).toBe(false);
    });
});

describe("GameFrame", () => {
    const game = { id: "new-york", frame: "new-york" } as unknown as GameDefinition;

    function start() {
        const button = mount("<button>Join</button>", "button") as HTMLButtonElement;
        render(<GameFrame game={game} />);
        const frame = document.querySelector("iframe")!;
        const tell = (data: unknown) =>
            act(async () => {
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data,
                        origin: window.location.origin,
                        source: frame.contentWindow
                    })
                );
            });
        return { button, frame, tell };
    }

    const press = (target: Element, code: string) =>
        target.dispatchEvent(
            new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true })
        );

    it("takes the keyboard from the button that started the game once it is ready", async () => {
        const { button, frame, tell } = start();
        button.focus();
        await tell({ type: "polaris-game:ready" });
        expect(document.activeElement).toBe(frame);
    });

    it("takes it back at the first driving key", async () => {
        const { button, frame, tell } = start();
        await tell({ type: "polaris-game:ready" });
        button.focus();
        expect(document.activeElement).toBe(button);

        press(button, "KeyM");
        expect(document.activeElement).toBe(button);
        press(button, "KeyW");
        expect(document.activeElement).toBe(frame);
    });

    it("leaves the keyboard in an open menu when a key is typed there", async () => {
        const { tell } = start();
        await tell({ type: "polaris-game:ready" });
        const item = mount(
            '<div role="menu"><div role="menuitem" tabindex="-1"></div></div>',
            "[role='menuitem']"
        ) as HTMLElement;
        item.focus();

        press(item, "KeyS");
        expect(document.activeElement).toBe(item);
    });

    it("does nothing with a driving key before the game is ready", () => {
        const { button } = start();
        button.focus();
        press(button, "KeyW");
        expect(document.activeElement).toBe(button);
    });

    it("drops the failure when a late ready takes it back", async () => {
        const { tell } = start();
        await tell({ type: "polaris-game:failed", reason: "error" });
        expect(screen.getByRole("alert")).toBeTruthy();

        await tell({ type: "polaris-game:ready" });
        expect(screen.queryByRole("alert")).toBeNull();
    });
});
