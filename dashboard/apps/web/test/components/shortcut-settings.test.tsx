// @vitest-environment jsdom

/**
 * The one keyboard every app listens through, and the screen that moves it.
 *
 * What somebody depends on: a screen's action answers its default key until
 * the key is moved, then answers the new one and not the old; a key another
 * action already has here is refused with that action's name; a change is
 * saved to the account at once and put back when the server refuses it; and
 * "This device only" keeps a change in this browser without asking the server.
 */

import * as ui from "@polaris/ui";
import { withMessages } from "../setup/i18n";
import { renderHook } from "@testing-library/react";
import { NO_SHORTCUT_OVERRIDES } from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const save = vi.fn();
vi.mock("@/app/(app)/shortcut-actions", () => ({
    saveShortcutsAction: (input: unknown) => save(input)
}));

const { ShortcutSettings } = await import("@/components/shortcuts/shortcut-settings");

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
    target.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    save.mockReset();
    // jsdom here has no storage of its own; this device's keys live in it.
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key)
    });
    ui.setAccountShortcuts(NO_SHORTCUT_OVERRIDES);
    ui.writeDeviceShortcuts(NO_SHORTCUT_OVERRIDES);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("listening", () => {
    it("answers the default key, then only the key it was moved to", () => {
        const newFolder = vi.fn();
        renderHook(() => ui.useShortcuts({ "drive.newFolder": newFolder }));
        expect(press("n").defaultPrevented).toBe(true);
        expect(newFolder).toHaveBeenCalledTimes(1);

        act(() => ui.setAccountShortcuts({ "drive.newFolder": ["Shift+n"] }));
        press("n");
        expect(newFolder).toHaveBeenCalledTimes(1);
        press("N", { shiftKey: true });
        expect(newFolder).toHaveBeenCalledTimes(2);
    });

    it("leaves a press it declined, or one it was told to stand down for, to the browser", () => {
        renderHook(() => ui.useShortcuts({ "drive.newFolder": () => false }));
        expect(press("n").defaultPrevented).toBe(false);

        const run = vi.fn();
        renderHook(() => ui.useShortcuts({ "databases.run": run }, { when: () => false }));
        expect(press("Enter", { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(run).not.toHaveBeenCalled();
    });

    it("lays this device's keys over the account's", () => {
        ui.setAccountShortcuts({ "tasks.new": ["Shift+n"] });
        ui.writeDeviceShortcuts({ "tasks.new": ["q"] });
        expect(ui.shortcutBindings().get("tasks.new")).toEqual(["q"]);
        expect(window.localStorage.getItem(ui.DEVICE_SHORTCUTS_KEY)).toBe('{"tasks.new":["q"]}');
    });
});

describe("the settings", () => {
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-shortcut="${id}"]`)!;

    it("lists an app's actions with the keys they answer to now", () => {
        render(withMessages(<ShortcutSettings app="drive" />));
        expect(within(row("drive.newFolder")).getByText("N")).toBeDefined();
        // The ones that work everywhere are listed with the app's own.
        expect(row("general.commandPalette")).not.toBeNull();
        expect(row("mail.archive")).toBeNull();
    });

    it("records a new key, saves it to the account and uses it at once", async () => {
        save.mockResolvedValue({ overrides: { "drive.newFolder": ["n", "Shift+f"] } });
        render(withMessages(<ShortcutSettings app="drive" />));
        fireEvent.click(within(row("drive.newFolder")).getByRole("button", { name: /Add a key/ }));
        const recorder = within(row("drive.newFolder")).getByRole("button", { name: /Press the new keys/ });
        fireEvent.keyDown(recorder, { key: "F", shiftKey: true });
        expect(save).toHaveBeenCalledWith({ "drive.newFolder": ["n", "Shift+f"] });
        expect(ui.shortcutBindings().get("drive.newFolder")).toEqual(["n", "Shift+f"]);
        await waitFor(() => expect(within(row("drive.newFolder")).getAllByText("F").length).toBe(1));
    });

    it("refuses a key another action here already has, and names it", () => {
        render(withMessages(<ShortcutSettings app="drive" />));
        fireEvent.click(within(row("drive.newFolder")).getByRole("button", { name: /Add a key/ }));
        const recorder = within(row("drive.newFolder")).getByRole("button", { name: /Press the new keys/ });
        fireEvent.keyDown(recorder, { key: "u" });
        expect(within(row("drive.newFolder")).getByRole("alert").textContent).toBe(
            "U already does upload files here."
        );
        fireEvent.keyDown(recorder, { key: "w", ctrlKey: true });
        expect(within(row("drive.newFolder")).getByRole("alert").textContent).toContain(
            "belongs to the browser"
        );
        expect(save).not.toHaveBeenCalled();
    });

    it("puts the keys back when the server refuses the change", async () => {
        save.mockResolvedValue({ error: "Your shortcuts could not be saved." });
        render(withMessages(<ShortcutSettings app="drive" />));
        fireEvent.click(within(row("drive.newFolder")).getByRole("button", { name: /Remove N/ }));
        expect(ui.shortcutBindings().get("drive.newFolder")).toEqual([]);
        await waitFor(() => expect(ui.shortcutBindings().get("drive.newFolder")).toEqual(["n"]));
    });

    it("keeps a change on this device only, without the server", () => {
        render(withMessages(<ShortcutSettings app="drive" />));
        fireEvent.click(screen.getByRole("switch", { name: "This device only" }));
        fireEvent.click(within(row("drive.newFolder")).getByRole("button", { name: /Remove N/ }));
        expect(save).not.toHaveBeenCalled();
        expect(ui.readDeviceShortcuts()).toEqual({ "drive.newFolder": [] });
        expect(within(row("drive.newFolder")).getByText("Changed on this device")).toBeDefined();
        // And back to the default from the row's own reset.
        fireEvent.click(within(row("drive.newFolder")).getByRole("button", { name: /Reset/ }));
        expect(ui.readDeviceShortcuts()).toEqual({});
    });

    it("keeps a device key that is free only because the account moved its holder", () => {
        save.mockResolvedValue({ overrides: { "drive.uploadFiles": ["Alt+u"] } });
        ui.setAccountShortcuts({ "drive.uploadFiles": ["Alt+u"] });
        render(withMessages(<ShortcutSettings app="drive" />));
        fireEvent.click(screen.getByRole("switch", { name: "This device only" }));
        fireEvent.click(within(row("drive.newFolder")).getByRole("button", { name: /Add a key/ }));
        const recorder = within(row("drive.newFolder")).getByRole("button", { name: /Press the new keys/ });
        fireEvent.keyDown(recorder, { key: "u" });
        expect(ui.readDeviceShortcuts()).toEqual({ "drive.newFolder": ["n", "u"] });
    });

    it("refuses an account key that is free only on this device, and names its holder", () => {
        ui.writeDeviceShortcuts({ "drive.uploadFiles": ["Alt+u"] });
        render(withMessages(<ShortcutSettings app="drive" />));
        fireEvent.click(within(row("drive.newFolder")).getByRole("button", { name: /Add a key/ }));
        const recorder = within(row("drive.newFolder")).getByRole("button", { name: /Press the new keys/ });
        fireEvent.keyDown(recorder, { key: "u" });
        expect(save).not.toHaveBeenCalled();
        expect(within(row("drive.newFolder")).getByRole("alert").textContent).toBe(
            "U already does upload files here."
        );
    });
});
