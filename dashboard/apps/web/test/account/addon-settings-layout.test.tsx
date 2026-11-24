// @vitest-environment jsdom
/**
 * An add-on's page draws every setting with Polaris's own controls, in the
 * groups its manifest declares - the Stream 100's knobs as dials, its buttons
 * as buttons - and never a native select, checkbox or slider. A manifest
 * without groups (an app older than them) reads as one list.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { addonSettingSections, readAddonManifest, readAddonSettingValues } from "@polaris/core/device-addons";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useLocale: () => "es-ES",
    useTranslations: () => (key: string) => key
}));
const desktop = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@/components/desktop-app", () => ({ useDesktopBridge: () => desktop.bridge }));
vi.mock("@polaris/ui", async (importOriginal) => ({ ...(await importOriginal<object>()), useToast: () => ({ show: vi.fn() }) }));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => [async () => false, null] }));

const { AddonPage } = await import("@/app/(app)/account/addons/addons-view");
const { resetAddonsCache } = await import("@/lib/device-addons-client");

const raw = JSON.parse(readFileSync(join(process.cwd(), "../../../device-addons/hercules-stream100/manifest.json"), "utf8")) as Record<string, unknown>;
const manifest = readAddonManifest(raw)!;

function open(rawManifest: unknown) {
    desktop.bridge = {
        addons: {
            get: async () => ({
                platform: "win32-x64",
                appVersion: "0.1.89",
                catalog: null,
                installed: [{ id: manifest.id, version: manifest.version, enabled: true, granted: [], manifest: rawManifest, update: null, run: { state: "sleeping" } }],
                installing: {}
            }),
            onChange: () => () => undefined,
            settings: async () => ({}),
            setSetting: vi.fn(async () => ({})),
            setEnabled: vi.fn(async () => true),
            uninstall: vi.fn(async () => true)
        }
    };
    return render(<AddonPage id={manifest.id} />);
}

afterEach(() => {
    cleanup();
    resetAddonsCache();
});

describe("an add-on's settings", () => {
    it("are sectioned in the declared order, loose ones first", () => {
        const sections = addonSettingSections(manifest);
        expect(sections.map((section) => section.group?.key ?? null)).toEqual([null, "knobs", "buttons", "turning", "screen"]);
        expect(sections[0]!.settings.map((setting) => setting.key)).toEqual(["enabled"]);
        expect(addonSettingSections({ settings: manifest.settings, groups: [] })).toEqual([{ group: null, settings: manifest.settings }]);
    });

    it("keep a button set to nothing as nothing, not its default", () => {
        expect(readAddonSettingValues(manifest.settings, { button3: null }).button3).toBeNull();
        expect(readAddonSettingValues(manifest.settings, {}).button3).toBe("call.camera");
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

    it("read as one list from an app that does not know groups", async () => {
        const { groups: _groups, ...old } = raw;
        const view = open({ ...old, settings: (old.settings as Record<string, unknown>[]).map(({ group: _group, ...setting }) => setting) });
        await waitFor(() => expect(view.container.querySelectorAll("[role=combobox]").length).toBe(9));
        expect(screen.queryByRole("region", { name: "Ruedas" })).toBeNull();
    });
});

