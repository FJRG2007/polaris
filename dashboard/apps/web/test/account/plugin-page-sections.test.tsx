// @vitest-environment jsdom
/**
 * A device plugin's page is laid out as a Polaris app's page is: the way back,
 * the header with its status, a row of actions (Settings, what the app offers
 * to do for it, Uninstall), then Settings, What's new one version at a time,
 * Permissions and Information. What's new reads the catalog's old one-string
 * changelog as one entry per version, newest first, the latest few open.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPluginManifest } from "@polaris/core/device-plugins";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useLocale: () => "en-US",
    useTranslations: () => (key: string, values?: Record<string, string | number>) =>
        values ? `${key}:${Object.values(values).join(",")}` : key
}));
const desktop = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@/components/desktop-app", () => ({ useDesktopBridge: () => desktop.bridge }));
vi.mock("@polaris/ui", async (importOriginal) => ({ ...(await importOriginal<object>()), useToast: () => ({ show: vi.fn() }) }));
const confirmed = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock("@/components/confirm-dialog", () => ({
    useConfirm: () => [
        async (options: { title: string }) => {
            confirmed.asked.push(options.title);
            return false;
        },
        null
    ]
}));

const { PluginPage } = await import("@/app/(app)/account/plugins/plugins-view");
const { resetPluginsCache } = await import("@/lib/device-plugins-client");

const raw = JSON.parse(readFileSync(join(process.cwd(), "../../../clients/device-plugins/hercules-stream100/manifest.json"), "utf8")) as Record<string, unknown>;
const manifest = readPluginManifest(raw)!;
const RELEASE = "https://github.com/FJRG2007/polaris/releases/download/device-addons/";
const CHANGELOG = "0.1.4: four. 0.1.5: five. 0.1.3: three. 0.1.2: two. 0.1.1: one.";

function open({ installed = true, changelog = CHANGELOG, runAction }: { installed?: boolean; changelog?: string; runAction?: (id: string, action: string) => Promise<boolean> } = {}) {
    const entry = {
        ...raw,
        packages: { "win32-x64": { url: `${RELEASE}a.zip`, sha256: "a".repeat(64), size: 2048 } },
        published: "2026-11-01T00:00:00.000Z",
        changelog
    };
    const copy = {
        id: manifest.id,
        version: "0.1.4",
        enabled: true,
        granted: manifest.permissions,
        manifest: raw,
        update: null,
        consent: [],
        failed: null,
        run: { state: "sleeping" },
        actions: [{ id: "driver", label: { "en-US": "Set up the driver" }, detail: { "en-US": "The Stream 100 uses another driver." } }]
    };
    const plugins = {
        get: async () => ({
            platform: "win32-x64",
            appVersion: "0.1.200",
            catalog: { schema: 1, issued: "2026-11-01T00:00:00.000Z", plugins: [entry] },
            autoUpdate: true,
            installed: installed ? [copy] : [],
            installing: {}
        }),
        onChange: () => () => undefined,
        settings: async () => ({}),
        setSetting: vi.fn(async () => ({})),
        setEnabled: vi.fn(async () => true),
        setAutoUpdate: vi.fn(async () => true),
        uninstall: vi.fn(async () => true),
        ...(runAction ? { runAction } : {})
    };
    desktop.bridge = { plugins };
    return { plugins, view: render(<PluginPage id={manifest.id} />) };
}

afterEach(() => {
    cleanup();
    resetPluginsCache();
    confirmed.asked = [];
});

describe("a device plugin's page", () => {
    it("has the app page's sections, in its order", async () => {
        const { view } = open({ runAction: async () => true });
        await screen.findByRole("heading", { level: 1, name: manifest.name });
        const titles = [...view.container.querySelectorAll("h2")].map((heading) => heading.textContent);
        expect(titles).toEqual(["plugins.detail.settings", "plugins.detail.changelog", "plugins.detail.permissions", "plugins.detail.information"]);
        expect(screen.getByRole("link", { name: "plugins.page.back" }).getAttribute("href")).toBe("/account/plugins");
        expect(screen.getByRole("region", { name: "plugins.detail.settings" }).id).toBe("settings");
    });

    it("puts Settings, the app's own action and Uninstall in the action row", async () => {
        const runAction = vi.fn(async () => true);
        open({ runAction });
        const row = await screen.findByRole("region", { name: "plugins.detail.actions" });
        expect(within(row).getByRole("link", { name: "plugins.detail.settings" }).getAttribute("href")).toBe("#settings");
        expect(within(row).getByText("The Stream 100 uses another driver.")).toBeTruthy();
        expect(within(row).getByRole("switch", { name: "plugins.detail.enabled" })).toBeTruthy();
        fireEvent.click(within(row).getByRole("button", { name: "Set up the driver" }));
        expect(runAction).toHaveBeenCalledWith(manifest.id, "driver");
        fireEvent.click(within(row).getByRole("button", { name: /plugins\.detail\.uninstall/ }));
        await vi.waitFor(() => expect(confirmed.asked).toEqual([`plugins.detail.uninstallTitle:${manifest.name}`]));
    });

    it("lists What's new one version at a time, newest first, the rest behind Show all", async () => {
        open();
        const news = await screen.findByRole("region", { name: "plugins.detail.changelog" });
        const versions = () => within(news).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
        expect(versions()).toEqual(["plugins.detail.release:0.1.5", "plugins.detail.release:0.1.4", "plugins.detail.release:0.1.3"]);
        expect(within(news).getByText("five.")).toBeTruthy();
        // The version this computer runs is marked.
        expect(within(news).getByText("plugins.detail.releaseCurrent")).toBeTruthy();
        fireEvent.click(within(news).getByRole("button", { name: "plugins.detail.releasesAll:5" }));
        expect(versions()).toHaveLength(5);
        expect(within(news).getByText("one.")).toBeTruthy();
        fireEvent.click(within(news).getByRole("button", { name: "plugins.detail.releasesFewer" }));
        expect(versions()).toHaveLength(3);
    });

    it("gives Information the version, size, date, publisher and category", async () => {
        open();
        const info = await screen.findByRole("region", { name: "plugins.detail.information" });
        const labels = [...info.querySelectorAll("dt")].map((term) => term.textContent);
        expect(labels).toEqual(["plugins.detail.version", "plugins.detail.size", "plugins.detail.published", "plugins.detail.publisher", "plugins.detail.category"]);
        expect(within(info).getByText("0.1.4")).toBeTruthy();
        expect(within(info).getByText(manifest.publisher)).toBeTruthy();
    });

    it("offers Install and no settings or uninstall before it is installed, and no What's new without notes", async () => {
        open({ installed: false, changelog: "" });
        const row = await screen.findByRole("region", { name: "plugins.detail.actions" });
        expect(within(row).getByRole("button", { name: "plugins.card.install" })).toBeTruthy();
        expect(within(row).queryByRole("button", { name: /plugins\.detail\.uninstall/ })).toBeNull();
        expect(screen.queryByRole("region", { name: "plugins.detail.settings" })).toBeNull();
        expect(screen.queryByRole("region", { name: "plugins.detail.changelog" })).toBeNull();
    });
});
