// @vitest-environment jsdom

/**
 * The start screen games share, in New York's markup: every way to play on its
 * first page - this device, a gamepad (only once one is connected), the phone
 * (opening its pairing page) and, where the host offers rooms, play with
 * others - and the last choice remembered where storage allows it.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as start from "../../../arcade/game/shared/start-screen.js";
import { t } from "../../../arcade/game/new-york/engine/i18n.js";

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

const KEY = "nyc-input";

function screen(
    pad = { connected: false, padName: "" },
    rooms: { state: () => "on" | "denied" | "off"; open: () => void } | null = null
) {
    const onChoose = vi.fn();
    const onOpenChange = vi.fn();
    const view = new start.StartScreen({
        t,
        storageKey: KEY,
        gamepad: () => pad,
        rooms,
        onChoose,
        onOpenChange
    });
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
        expect(start.rememberedChoice(KEY)).toBe("device");
    });

    it("lists every way to play on its first page, with no page in between", () => {
        screen().view.open();
        const main = document.querySelector('[data-start-view="main"]')!;
        expect(main.querySelector('[data-start-choose="device"]')).not.toBeNull();
        expect(main.querySelector('[data-start-choose="gamepad"]')).not.toBeNull();
        expect(main.querySelector('[data-start-open="phone"]')).not.toBeNull();
        expect(main.querySelector("[data-start-together]")).not.toBeNull();
        expect(document.querySelector('[data-start-view="controller"]')).toBeNull();
        expect(
            button('[data-start-open="phone"]').querySelector('[data-t="start.phone"]')
        ).not.toBeNull();
        expect(t("start.phone")).toBe("Phone as controller");
    });

    it("waits for a gamepad before it can be chosen", () => {
        const { view, onChoose, pad } = screen();
        view.open();
        const gamepad = button('[data-start-choose="gamepad"]');
        expect(gamepad.disabled).toBe(true);
        expect(document.getElementById("start-pad-status")!.textContent).toBe(
            "Turn it on and press any button"
        );
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
        expect(start.rememberedChoice(KEY)).toBe("gamepad");
    });

    it("takes Start on a connected gamepad as choosing it, and B back a page", () => {
        const { view, onChoose } = screen({ connected: true, padName: "Pad" });
        view.open();
        view.show("phone");
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

    it("focuses the last choice first, and works with storage blocked", () => {
        localStorage.setItem(KEY, "phone");
        screen().view.open();
        expect(document.activeElement).toBe(button('[data-start-open="phone"]'));

        document.body.innerHTML = markup;
        const blocked = () => {
            throw new Error("blocked");
        };
        vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
        const { view, onChoose } = screen();
        view.open();
        expect(start.rememberedChoice(KEY)).toBe("");
        view.activate();
        expect(onChoose).toHaveBeenCalledWith("device");
    });
});

describe("play with others", () => {
    it("is not there where the host offers no rooms", () => {
        screen().view.open();
        expect(button("[data-start-together]").hidden).toBe(true);
    });

    it("asks the host for its rooms and keeps the screen open behind them", () => {
        const open = vi.fn();
        const { view, onChoose } = screen(undefined, { state: () => "on", open });
        view.open();
        const together = button("[data-start-together]");
        expect(together.hidden).toBe(false);
        expect(together.disabled).toBe(false);
        expect(document.getElementById("start-together-status")!.textContent).toBe(
            "Open a room or join one with a code"
        );
        together.click();
        expect(open).toHaveBeenCalledTimes(1);
        expect(view.isOpen).toBe(true);
        expect(onChoose).not.toHaveBeenCalled();
    });

    it("is shown off with the reason for somebody an admin turned it off for", () => {
        const open = vi.fn();
        screen(undefined, { state: () => "denied", open }).view.open();
        const together = button("[data-start-together]");
        expect(together.hidden).toBe(false);
        expect(together.disabled).toBe(true);
        expect(document.getElementById("start-together-status")!.textContent).toBe(
            "An admin turned this off for your account"
        );
        together.click();
        expect(open).not.toHaveBeenCalled();
    });
});
