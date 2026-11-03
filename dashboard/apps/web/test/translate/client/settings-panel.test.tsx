// @vitest-environment jsdom
/**
 * The administrator's Translate settings: the engines are a list in the order
 * they are tried, moved by dragging or by their arrows, and Save sends that
 * order with the rest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_SETTINGS, type TranslateSettings } from "@polaris-app/translate/src/model/schemas";

const saved: unknown[] = [];

vi.mock("@polaris/app-host/client", async (original) => {
    const actual = await original<typeof import("@polaris/app-host/client")>();
    return {
        ...actual,
        hostUi: {
            ...actual.hostUi,
            i18nProvider: { ...actual.hostUi?.i18nProvider, useLocale: () => "en-US" },
            runAction: { runAction: async (call: () => Promise<unknown>) => call() }
        }
    };
});

vi.mock("@polaris-app/translate/src/actions/translate", () => ({
    settingsAction: async () => ({ ok: true, settings: DEFAULT_SETTINGS }),
    saveSettingsAction: async (input: TranslateSettings) => {
        saved.push(input);
        return { ok: true, settings: input };
    }
}));

const { SettingsPanel } = await import("@polaris-app/translate/src/screens/settings-panel");

beforeEach(() => {
    saved.length = 0;
});

afterEach(cleanup);

async function open(): Promise<void> {
    render(<SettingsPanel />);
    await act(async () => {});
}

/** The engine switches only: the list of engines, not the length limit below it. */
const engineSwitches = () => within(screen.getByRole("group", { name: "Engines" })).getAllByRole("switch");
const names = () => engineSwitches().map((one) => one.getAttribute("aria-label"));

describe("the engines' order", () => {
    it("lists them in the order they are tried", async () => {
        await open();
        expect(names()).toEqual(["In your browser", "DeepL", "Google Cloud", "Polar's model"]);
        expect(screen.getByRole("button", { name: "Move In your browser up" })).toHaveProperty(
            "disabled",
            true
        );
    });

    it("moves one with its arrows and saves the new order", async () => {
        await open();
        fireEvent.click(screen.getByRole("button", { name: "Move Polar's model up" }));
        expect(names()).toEqual(["In your browser", "DeepL", "Polar's model", "Google Cloud"]);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save" }));
        });
        expect(saved).toHaveLength(1);
        expect((saved[0] as TranslateSettings).order).toEqual([
            "browser",
            "deepl",
            "polar",
            "google"
        ]);
    });

    it("moves one by dragging it onto another row", async () => {
        await open();
        const rows = engineSwitches().map((one) => one.closest("[draggable]")!);
        const data = new Map<string, string>();
        const dataTransfer = {
            setData: (type: string, value: string) => data.set(type, value),
            getData: (type: string) => data.get(type) ?? ""
        };
        fireEvent.dragStart(rows[3]!, { dataTransfer });
        fireEvent.dragOver(rows[0]!, { dataTransfer });
        fireEvent.drop(rows[0]!, { dataTransfer });
        expect(names()).toEqual(["Polar's model", "In your browser", "DeepL", "Google Cloud"]);
    });

    it("keeps Save off until something changed, and after moving it back", async () => {
        await open();
        const save = () => screen.getByRole("button", { name: "Save" });
        expect(save()).toHaveProperty("disabled", true);
        fireEvent.click(screen.getByRole("button", { name: "Move DeepL down" }));
        expect(save()).toHaveProperty("disabled", false);
        fireEvent.click(screen.getByRole("button", { name: "Move DeepL up" }));
        expect(save()).toHaveProperty("disabled", true);
    });
});
