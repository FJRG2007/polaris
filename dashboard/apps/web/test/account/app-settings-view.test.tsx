// @vitest-environment jsdom
/**
 * Settings > This app: the desktop app's own settings, drawn from the shared
 * schema and read and written through the app's bridge.
 *
 * What has to hold: the screen draws from what the app answers, a change shows
 * at once and is put back when the app refuses it, the sections exist only
 * inside the app, and a browser is told where these settings are changed.
 */

import { MessagesWrapper } from "../setup/i18n";
import { COMMAND_ENTRY_FIELDS, navigationEntries } from "@/lib/search/entries";
import { searchItems } from "@polaris/core/search-text";
import { APP_SETTINGS } from "@polaris/core/app-settings";
import appSettingsMessages from "../../messages/en-US/appSettings.json";
import { APP_SECTIONS, sectionOffered } from "@/lib/apps";
import { APP_SETTING_CATEGORIES } from "@polaris/core/app-settings";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
const network = vi.hoisted(() => ({ online: true, recovered: 0 }));
vi.mock("@enigmax/primitives/react/network", () => ({ useNetworkState: () => network }));

const { AppSettingsView, forgetAppSettingsSnapshot } = await import(
    "../../src/app/(app)/account/app/[category]/app-settings-view"
);

const SNAPSHOT = {
    openAtLogin: true,
    startMinimized: true,
    minimizeToTray: true,
    launcher: true,
    launcherBinding: "Alt+Space",
    launcherGameMode: true,
    launcherEngine: "google",
    launcherClipboard: true,
    launcherClipboardKeep: "week",
    voiceWidget: true,
    voiceWidgetGameOnly: false,
    hardwareAcceleration: true,
    restartPending: false,
    launcherClipboardPersists: true,
    launcherKey: "Alt+Space",
    launcherProblem: null,
    version: "0.1.72",
    server: "https://polaris.example.test",
    servers: [{ origin: "https://polaris.example.test", name: "Home" }]
};

function fakeBridge(appSettings: Record<string, unknown> = {}) {
    return {
        version: "0.1.72",
        platform: "win32",
        notify: vi.fn(),
        closeNotice: vi.fn(),
        pickFolder: vi.fn(),
        pushLocal: vi.fn(),
        openWindow: vi.fn(),
        appSettings: {
            get: vi.fn(async () => SNAPSHOT),
            set: vi.fn(async (change: { key: string; value: unknown }) => ({ ...SNAPSHOT, [change.key]: change.value })),
            record: vi.fn(async () => undefined),
            setShortcut: vi.fn(async () => SNAPSHOT),
            clearClipboard: vi.fn(async () => undefined),
            relaunch: vi.fn(async () => undefined),
            manageHosts: vi.fn(async () => undefined),
            announce: vi.fn(async () => undefined),
            onChange: vi.fn(() => () => undefined),
            onOpen: vi.fn(() => () => undefined),
            ...appSettings
        }
    };
}

function install(bridge: unknown): void {
    (window as { polarisDesktop?: unknown }).polarisDesktop = bridge;
}

async function draw(category: (typeof APP_SETTING_CATEGORIES)[number]) {
    render(
        <MessagesWrapper>
            <AppSettingsView category={category} />
        </MessagesWrapper>
    );
    await act(async () => {
        await Promise.resolve();
    });
}

beforeEach(() => forgetAppSettingsSnapshot());
afterEach(() => {
    cleanup();
    network.online = true;
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
});

describe("the app's settings screen", () => {
    it("draws the values the app answers", async () => {
        install(fakeBridge({ get: vi.fn(async () => ({ ...SNAPSHOT, openAtLogin: false })) }));
        await draw("general");
        expect(screen.getByRole("switch", { name: "Open with the computer" }).getAttribute("aria-checked")).toBe(
            "false"
        );
        // Shown only while the switch it depends on is on.
        expect(screen.queryByRole("switch", { name: "Start in the tray" })).toBeNull();
    });

    it("shows a change at once and puts it back when the app refuses it", async () => {
        let refuse: (value: unknown) => void = () => undefined;
        const set = vi.fn(() => new Promise((resolve) => (refuse = resolve)));
        install(fakeBridge({ set }));
        await draw("window");
        const toggle = screen.getByRole("switch", { name: "Minimize to tray" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        await act(async () => toggle.click());
        expect(set).toHaveBeenCalledWith({ key: "minimizeToTray", value: false });
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        await act(async () => refuse(null));
        expect(screen.getByRole("switch", { name: "Minimize to tray" }).getAttribute("aria-checked")).toBe("true");
    });

    it("offers the overlay's pin, lock key and per-game switch only to an app that has them", async () => {
        install(fakeBridge());
        await draw("voice");
        expect(screen.queryByRole("switch", { name: "Pin" })).toBeNull();
        expect(screen.queryByText("Overlay lock key")).toBeNull();
        expect(screen.queryByText("Overlay in games")).toBeNull();
        cleanup();
        forgetAppSettingsSnapshot();
        const newer = {
            ...SNAPSHOT,
            voiceWidgetPinned: true,
            overlayLockKey: "Shift+` / Ctrl+Shift+`",
            overlayGames: [{ key: "cs2.exe", name: "Counter-Strike 2", on: true, running: true }],
            features: ["overlayPin", "overlayLockKey", "overlayGames"]
        };
        install(
            fakeBridge({
                get: vi.fn(async () => newer),
                setOverlayShortcut: vi.fn(async () => newer),
                setOverlayGame: vi.fn(async () => newer)
            })
        );
        await draw("voice");
        expect(screen.getByRole("switch", { name: "Pin" }).getAttribute("aria-checked")).toBe("true");
        expect(screen.getByText("Shift+` / Ctrl+Shift+`")).toBeTruthy();
        expect(screen.getByRole("switch", { name: "Counter-Strike 2" }).getAttribute("aria-checked")).toBe("true");
    });

    it("turns the overlay off for a game at once and back when the app refuses it", async () => {
        let refuse: (value: unknown) => void = () => undefined;
        const setOverlayGame = vi.fn(() => new Promise((resolve) => (refuse = resolve)));
        const newer = {
            ...SNAPSHOT,
            overlayGames: [{ key: "cs2.exe", name: "Counter-Strike 2", on: true, running: true }],
            features: ["overlayGames"]
        };
        install(fakeBridge({ get: vi.fn(async () => newer), setOverlayGame }));
        await draw("voice");
        await act(async () => screen.getByRole("switch", { name: "Counter-Strike 2" }).click());
        expect(setOverlayGame).toHaveBeenCalledWith("cs2.exe", false);
        expect(screen.getByRole("switch", { name: "Counter-Strike 2" }).getAttribute("aria-checked")).toBe("false");
        await act(async () => refuse(null));
        expect(screen.getByRole("switch", { name: "Counter-Strike 2" }).getAttribute("aria-checked")).toBe("true");
    });

    it("names the launcher by the key it holds", async () => {
        install(fakeBridge({ get: vi.fn(async () => ({ ...SNAPSHOT, launcherKey: "Ctrl+K" })) }));
        await draw("search");
        expect(screen.getByRole("switch", { name: "Ctrl+K search" })).toBeTruthy();
    });

    it("lists the hosts the app knows and sends their changes to the app's own page", async () => {
        const bridge = fakeBridge();
        install(bridge);
        await draw("hosts");
        expect(screen.getByText("Home")).toBeTruthy();
        expect(screen.getByText("In use")).toBeTruthy();
        await act(async () => screen.getByRole("button", { name: "Manage hosts" }).click());
        expect(bridge.appSettings.manageHosts).toHaveBeenCalled();
    });

    it("offers the restart a setting waits on", async () => {
        install(fakeBridge({ get: vi.fn(async () => ({ ...SNAPSHOT, restartPending: true })) }));
        await draw("advanced");
        expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
    });

    it("keeps the update check for a connection when the page was opened offline", async () => {
        const checkForUpdates = vi.fn(async () => ({ kind: "current" }));
        install({ ...fakeBridge(), checkForUpdates });
        network.online = false;
        await draw("updates");
        const check = screen.getByRole("button", { name: "Check for updates" });
        expect(check.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(appSettingsMessages.updates.offline)).toBeTruthy();
        await act(async () => check.click());
        expect(checkForUpdates).not.toHaveBeenCalled();
    });

    it("says where these settings are changed when the page is not in the app", async () => {
        await draw("general");
        expect(screen.getByText("Open this in the desktop app")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Get the desktop app" }).getAttribute("href")).toBe(
            "/account/downloads"
        );
    });
});

describe("the This app group", () => {
    const sections = (APP_SECTIONS.account ?? []).filter((section) => section.desktopOnly);

    it("has one section per category, then the device add-ons", () => {
        expect(sections.map((section) => section.href)).toEqual([
            ...APP_SETTING_CATEGORIES.map((category) => `/account/app/${category}`),
            "/account/addons"
        ]);
    });

    it("is offered only inside the desktop app", () => {
        const gate = { isAdmin: true, held: [], installed: [] };
        for (const section of sections) {
            expect(sectionOffered(section, gate)).toBe(false);
            expect(sectionOffered(section, { ...gate, desktop: true })).toBe(true);
        }
        const found = (desktop?: boolean) =>
            navigationEntries(false, [], desktop === undefined ? undefined : { held: [], installed: [], desktop }).some(
                (entry) => entry.href.startsWith("/account/app/")
            );
        expect(found()).toBe(false);
        expect(found(false)).toBe(false);
        expect(found(true)).toBe(true);
    });
    it("finds every setting from the search, on its own category's page", () => {
        const entries = navigationEntries(false, [], { held: [], installed: [], desktop: true });
        const items = appSettingsMessages.items as Record<string, { label: string }>;
        for (const setting of APP_SETTINGS) {
            const label = items[setting.key]?.label.replace("{key}", "Alt+Space");
            expect(label, setting.key).toBeTruthy();
            const hrefs = searchItems(entries, label!, COMMAND_ENTRY_FIELDS).map((entry) => entry.href);
            expect(hrefs, label).toContain(`/account/app/${setting.category}`);
        }
    });
});
