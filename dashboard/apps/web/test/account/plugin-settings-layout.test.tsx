// @vitest-environment jsdom
/**
 * A plugin's page draws every setting with Polaris's own controls, in the
 * groups its manifest declares - the Stream 100's knobs as dials, its buttons
 * as buttons - and never a native select, checkbox or slider. A manifest
 * without groups (an app older than them) reads as one list. Every group and
 * setting a search result can name is drawn under that name, tiles included,
 * and the page scrolls to the one in its address. What the app offers to do
 * for the plugin (its host actions) is a notice with its button.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { pluginSettingSections, pluginSettingTargets, readPluginManifest, readPluginSettingValues } from "@polaris/core/device-plugins";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useLocale: () => "es-ES",
    useTranslations: () => (key: string) => key
}));
const desktop = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@/components/desktop-app", () => ({ useDesktopBridge: () => desktop.bridge }));
vi.mock("@polaris/ui", async (importOriginal) => ({ ...(await importOriginal<object>()), useToast: () => ({ show: vi.fn() }) }));
const asked = vi.hoisted(() => ({ answer: false, options: [] as unknown[] }));
vi.mock("@/components/confirm-dialog", () => ({
    useConfirm: () => [
        async (options: unknown) => {
            asked.options.push(options);
            return asked.answer;
        },
        null
    ]
}));

const { PluginPage } = await import("@/app/(app)/account/plugins/plugins-view");
const { resetPluginsCache, resetPluginSettingsCache } = await import("@/lib/device-plugins-client");

const raw = JSON.parse(readFileSync(join(process.cwd(), "../../../clients/device-plugins/hercules-stream100/manifest.json"), "utf8")) as Record<string, unknown>;
const manifest = readPluginManifest(raw)!;

function open(rawManifest: unknown, extra: { actions?: unknown[]; runAction?: (id: string, action: string) => Promise<boolean> } = {}) {
    desktop.bridge = {
        plugins: {
            get: async () => ({
                platform: "win32-x64",
                appVersion: "0.1.89",
                catalog: null,
                installed: [{ id: manifest.id, version: manifest.version, enabled: true, granted: [], manifest: rawManifest, update: null, run: { state: "sleeping" }, ...(extra.actions ? { actions: extra.actions } : {}) }],
                installing: {}
            }),
            onChange: () => () => undefined,
            settings: async () => ({}),
            setSetting: vi.fn(async () => ({})),
            setEnabled: vi.fn(async () => true),
            uninstall: vi.fn(async () => true),
            ...(extra.runAction ? { runAction: extra.runAction } : {})
        }
    };
    return render(<PluginPage id={manifest.id} />);
}

afterEach(() => {
    cleanup();
    resetPluginsCache();
    resetPluginSettingsCache();
    asked.answer = false;
    asked.options = [];
});

describe("a plugin's settings", () => {
    it("are sectioned in the declared order, loose ones first", () => {
        const sections = pluginSettingSections(manifest);
        expect(sections.map((section) => section.group?.key ?? null)).toEqual([null, "knobs", "buttons", "turning", "screen"]);
        expect(sections[0]!.settings.map((setting) => setting.key)).toEqual(["enabled"]);
        expect(pluginSettingSections({ settings: manifest.settings, groups: [] })).toEqual([{ group: null, settings: manifest.settings }]);
    });

    it("keep a button set to nothing as nothing, not its default", () => {
        expect(readPluginSettingValues(manifest.settings, { button3: null }).button3).toBeNull();
        expect(readPluginSettingValues(manifest.settings, {}).button3).toBe("call.camera");
    });

    it("draw the knobs and buttons as the controller's tiles, in the reader's language, with no native control", async () => {
        const view = open(raw);
        const knobs = await screen.findByRole("region", { name: "Ruedas" });
        expect(within(knobs).getAllByRole("combobox")).toHaveLength(4);
        expect(within(knobs).getByText("Rueda 1")).toBeTruthy();
        expect(within(screen.getByRole("region", { name: "Botones iluminados" })).getAllByRole("combobox")).toHaveLength(4);
        expect(screen.getByRole("region", { name: "Pantalla" })).toBeTruthy();
        expect(view.container.querySelectorAll("select, option, input[type=range], input[type=checkbox], textarea")).toHaveLength(0);
    });

    it("draw every place a search result names, tiles and groups included, and scroll to the one in the address", async () => {
        // jsdom draws nothing, so it has no scrollIntoView: record the calls instead.
        const scrolled: string[] = [];
        const before = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (this: Element) {
            scrolled.push(this.id);
        };
        window.history.replaceState(null, "", "#setting-knob2");
        try {
            const view = open(raw);
            await screen.findByRole("region", { name: "Ruedas" });
            const targets = pluginSettingTargets(manifest, "es-ES");
            expect(targets.some((target) => target.kind === "group")).toBe(true);
            for (const target of targets) expect(view.container.querySelector(`[id="${target.anchor}"]`), target.anchor).not.toBeNull();
            // A knob is a tile, not a row: its own element carries the name.
            expect(view.container.querySelector("#setting-knob2")?.textContent).toContain("Rueda 2");
            await waitFor(() => expect(scrolled).toContain("setting-knob2"));
        } finally {
            window.history.replaceState(null, "", "#");
            Element.prototype.scrollIntoView = before;
        }
    });

    it("read as one list from an app that does not know groups", async () => {
        const { groups: _groups, ...old } = raw;
        const view = open({ ...old, settings: (old.settings as Record<string, unknown>[]).map(({ group: _group, ...setting }) => setting) });
        await waitFor(() => expect(view.container.querySelectorAll("[role=combobox]").length).toBe(9));
        expect(screen.queryByRole("region", { name: "Ruedas" })).toBeNull();
    });

    it("offer what the app can do for the plugin as a notice with its button, and run it on a click", async () => {
        const runAction = vi.fn(async () => true);
        const action = { id: "driver", label: { "en-US": "Set up the driver", "es-ES": "Instalar el driver" }, detail: { "en-US": "The Stream 100 uses another driver.", "es-ES": "El Stream 100 usa otro driver." } };
        open(raw, { actions: [action], runAction });
        expect(await screen.findByText("El Stream 100 usa otro driver.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Instalar el driver" }));
        await waitFor(() => expect(runAction).toHaveBeenCalledWith(manifest.id, "driver"));
    });

    it("say the vendor program is using the controller, and close it only once the person says yes", async () => {
        const runAction = vi.fn(async () => true);
        const action = { id: "useInPolaris", subject: "Hercules Stream Control", label: { "en-US": "Use it in Polaris" }, detail: { "en-US": "Hercules Stream Control is using the controller." } };
        open(raw, { actions: [action], runAction });
        // The page's own words, in the reader's language (keys here).
        expect(await screen.findByText("plugins.hostAction.useInPolaris.detail")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "plugins.hostAction.useInPolaris.label" }));
        await waitFor(() => expect(asked.options).toHaveLength(1));
        expect(asked.options[0]).toMatchObject({ title: "plugins.hostAction.useInPolaris.title", confirmLabel: "plugins.hostAction.useInPolaris.confirm" });
        expect(runAction).not.toHaveBeenCalled();
        asked.answer = true;
        fireEvent.click(screen.getByRole("button", { name: "plugins.hostAction.useInPolaris.label" }));
        await waitFor(() => expect(runAction).toHaveBeenCalledWith(manifest.id, "useInPolaris"));
    });

    it("offer no host action to an app that cannot run one", async () => {
        open(raw, { actions: [{ id: "driver", label: { "en-US": "Set up the driver", "es-ES": "Instalar el driver" } }] });
        await screen.findByRole("region", { name: "Ruedas" });
        expect(screen.queryByRole("button", { name: "Instalar el driver" })).toBeNull();
    });
});
