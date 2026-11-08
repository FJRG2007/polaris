// @vitest-environment jsdom

/**
 * New York's start screen: play on this device or with a controller, the
 * gamepad only once one is connected, the phone opening its pairing page, and
 * the last choice remembered where storage allows it.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as start from "../../../arcade/game/new-york/engine/start-screen.js";

const page = readFileSync(resolve(__dirname, "../../../arcade/game/new-york/index.html"), "utf8");
const markup = page.match(/<dialog id="start-screen"[\s\S]*?<\/dialog>/)![0];

beforeAll(() => {
    // jsdom has the element but not its modal methods
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
        this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
        this.open = false;
    };
});

/** A storage of its own per test (this environment's jsdom has none). */
function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, String(value))
    };
}

beforeEach(() => {
    document.body.innerHTML = markup;
    vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => vi.unstubAllGlobals());

function screen(pad = { connected: false, padName: "" }) {
    const onChoose = vi.fn();
    const onOpenChange = vi.fn();
    const view = new start.StartScreen({ gamepad: () => pad, onChoose, onOpenChange });
    return { view, onChoose, onOpenChange, pad };
}

const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;

describe("the start screen", () => {
    it("opens paused on this device's choice, and playing on it is remembered", () => {
        const { view, onChoose, onOpenChange } = screen();
        view.open();
        expect(onOpenChange).toHaveBeenLastCalledWith(true);
        expect(document.activeElement).toBe(button('[data-start-choose="device"]'));
        view.activate();
        expect(onChoose).toHaveBeenCalledWith("device");
        expect(onOpenChange).toHaveBeenLastCalledWith(false);
        expect(view.isOpen).toBe(false);
        expect(start.rememberedChoice()).toBe("device");
    });

    it("waits for a gamepad before it can be chosen, and lists the phone", () => {
        const { view, onChoose, pad } = screen();
        view.open();
        button('[data-start-open="controller"]').click();
        const gamepad = button('[data-start-choose="gamepad"]');
        expect(gamepad.disabled).toBe(true);
        expect(document.getElementById("start-pad-status")!.textContent).toBe(
            "Turn it on and press any button"
        );
        const phone = button('[data-start-open="phone"]');
        expect(phone.disabled).toBe(false);
        expect(phone.querySelector('[data-t="start.phoneHint"]')).not.toBeNull();
        gamepad.click();
        view.close();
        expect(onChoose).not.toHaveBeenCalled();

        pad.connected = true;
        pad.padName = "DualSense Wireless Controller";
        view.refresh();
        expect(gamepad.disabled).toBe(false);
        expect(document.activeElement).toBe(gamepad);
        expect(document.getElementById("start-pad-status")!.textContent).toBe(
            "DualSense Wireless Controller"
        );
        view.activate();
        expect(onChoose).toHaveBeenCalledWith("gamepad");
        expect(start.rememberedChoice()).toBe("gamepad");
    });

    it("takes Start on a connected gamepad as choosing it, and B back a page", () => {
        const { view, onChoose } = screen({ connected: true, padName: "Pad" });
        view.open();
        view.move(1);
        view.activate();
        expect(document.querySelector<HTMLElement>('[data-start-view="controller"]')!.hidden).toBe(
            false
        );
        view.goBack();
        expect(document.querySelector<HTMLElement>('[data-start-view="main"]')!.hidden).toBe(false);
        view.goBack();
        expect(view.isOpen).toBe(true);
        view.close();
        expect(onChoose).toHaveBeenCalledWith("gamepad");
    });

    it("keeps no key for the game while it is open", () => {
        const { view } = screen();
        view.open();
        const game = vi.fn();
        window.addEventListener("keydown", game);
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
        window.removeEventListener("keydown", game);
        expect(game).not.toHaveBeenCalled();
    });

    it("focuses the controller first after it was last chosen, and works with storage blocked", () => {
        localStorage.setItem("nyc-input", "gamepad");
        screen().view.open();
        expect(document.activeElement).toBe(button('[data-start-open="controller"]'));

        document.body.innerHTML = markup;
        const blocked = () => {
            throw new Error("blocked");
        };
        vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
        const { view, onChoose } = screen();
        view.open();
        expect(start.rememberedChoice()).toBe("");
        view.activate();
        expect(onChoose).toHaveBeenCalledWith("device");
    });
});
