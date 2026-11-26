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
import { ToastProvider } from "@polaris/ui";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A store of this test's own: the runtime's may be missing or shared between files.
const kept = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, String(value)),
        removeItem: (key: string) => void kept.delete(key),
        clear: () => kept.clear()
    }
});
const route = vi.hoisted(() => ({ pathname: "/account/app/general" }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => {}, refresh: () => {} }),
    usePathname: () => route.pathname
}));
const network = vi.hoisted(() => ({ online: true, recovered: 0 }));
vi.mock("@enigmax/primitives/react/network", () => ({ useNetworkState: () => network }));

const { AppSettingsView, AppSettingsScreen, forgetAppSettingsSnapshot } = await import(
    "../../src/app/(app)/account/app/[category]/app-settings-view"
);
const { defaultAppSettings } = await import("../../src/components/this-app/app-settings-values");
const { default: CategoryLoading } = await import("../../src/app/(app)/account/app/[category]/loading");
const { ThisDeviceApp, forgetDesktopUpdateState } = await import("../../src/components/this-app/this-device-app");

const SNAPSHOT = {
    openAtLogin: true,
    startMinimized: true,
    minimizeToTray: true,
    launcher: true,
    launcherBinding: "Alt+Space",
    launcherGameMode: false,
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

beforeEach(() => {
    forgetAppSettingsSnapshot();
    forgetDesktopUpdateState();
    window.localStorage.clear();
});
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

    it("names the chosen lock key in the voice widget's hint, and the default keys without one", async () => {
        const chosen = { ...SNAPSHOT, overlayLockBinding: "Mod+Alt+O", overlayLockKey: "Ctrl+Alt+O", features: ["overlayLockKey"] };
        install(fakeBridge({ get: vi.fn(async () => chosen), setOverlayShortcut: vi.fn(async () => chosen) }));
        await draw("voice");
        expect(screen.getByText("Who is in the call and who is talking. Ctrl+Alt+O unlocks it.")).toBeTruthy();
        cleanup();
        forgetAppSettingsSnapshot();
        install(fakeBridge());
        await draw("voice");
        expect(screen.getByText(appSettingsMessages.items.voiceWidget.hint)).toBeTruthy();
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

    it("draws every control at once with the schema's defaults on a device that never saw an answer", async () => {
        install(fakeBridge({ get: vi.fn(() => new Promise(() => undefined)) }));
        await draw("search");
        expect(screen.getByText(appSettingsMessages.items.launcherEngine.label)).toBeTruthy();
        expect(document.querySelector("[aria-busy]")).toBeNull();
        // Each control holds its default from the one schema, not a placeholder.
        expect(screen.getByRole("switch", { name: "Alt+Space search" }).getAttribute("aria-checked")).toBe("true");
        expect(screen.getByRole("combobox", { name: appSettingsMessages.items.launcherEngine.label }).textContent).toContain(
            appSettingsMessages.engines.google
        );
        expect(screen.getByRole("button", { name: appSettingsMessages.shortcut.change })).toBeTruthy();
        cleanup();
        install(fakeBridge({ get: vi.fn(() => new Promise(() => undefined)) }));
        await draw("advanced");
        const hardware = APP_SETTINGS.find((entry) => entry.key === "hardwareAcceleration")!;
        expect(screen.getByRole("switch", { name: appSettingsMessages.items.hardwareAcceleration.label }).getAttribute("aria-checked")).toBe(
            String(hardware.default)
        );
        expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
    });

    it("draws every row of every category with a control before the app answers", async () => {
        for (const category of APP_SETTING_CATEGORIES) {
            if (category === "hosts") continue;
            install(fakeBridge({ get: vi.fn(() => new Promise(() => undefined)) }));
            await draw(category);
            expect(document.querySelector("[aria-busy]")).toBeNull();
            // The voice widget's people limit is a number control, drawn at its default too.
            if (category === "voice") expect(screen.getAllByRole("slider").length).toBeGreaterThan(0);
            cleanup();
        }
    });

    it("takes every default from the shared schema", () => {
        const defaults = defaultAppSettings();
        for (const entry of APP_SETTINGS) expect(defaults[entry.key as keyof typeof defaults]).toEqual(entry.default);
        expect(defaults.restartPending).toBe(false);
        expect(defaults.features).toEqual([]);
    });

    it("swaps a default only where the app's answer differs", async () => {
        let answer: (value: unknown) => void = () => undefined;
        install(fakeBridge({ get: vi.fn(() => new Promise((resolve) => (answer = resolve))) }));
        await draw("window");
        const before = screen.getByRole("switch", { name: "Minimize to tray" });
        expect(before.getAttribute("aria-checked")).toBe("true");
        await act(async () => answer({ ...SNAPSHOT, minimizeToTray: false }));
        // The same element, now off: swapped in place rather than redrawn.
        expect(screen.getByRole("switch", { name: "Minimize to tray" })).toBe(before);
        expect(before.getAttribute("aria-checked")).toBe("false");
    });

    it("changes a default at once and puts it back, with a message, when the app refuses it", async () => {
        let refuse: (value: unknown) => void = () => undefined;
        const set = vi.fn(() => new Promise((resolve) => (refuse = resolve)));
        install(fakeBridge({ get: vi.fn(() => new Promise(() => undefined)), set }));
        render(
            <MessagesWrapper>
                <ToastProvider>
                    <AppSettingsView category="advanced" />
                </ToastProvider>
            </MessagesWrapper>
        );
        const name = appSettingsMessages.items.hardwareAcceleration.label;
        await act(async () => screen.getByRole("switch", { name }).click());
        expect(set).toHaveBeenCalledWith({ key: "hardwareAcceleration", value: false });
        expect(screen.getByRole("switch", { name }).getAttribute("aria-checked")).toBe("false");
        // The restart it needs is offered with the switch, not after the app answers.
        expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
        await act(async () => refuse(null));
        expect(screen.getByRole("switch", { name }).getAttribute("aria-checked")).toBe("true");
        expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
        expect(screen.getByText(appSettingsMessages.saveFailed)).toBeTruthy();
        // A default that was never an answer is not kept as one.
        expect(window.localStorage.getItem("polaris.this-app.advanced")).toBeNull();
    });

    it("follows the restart a setting needs both ways, and takes the app's word on it", async () => {
        window.localStorage.setItem("polaris.this-app.advanced", JSON.stringify({ ...SNAPSHOT, hardwareAcceleration: false, restartPending: true }));
        let accept: (value: unknown) => void = () => undefined;
        const set = vi.fn(() => new Promise((resolve) => (accept = resolve)));
        install(fakeBridge({ get: vi.fn(() => new Promise(() => undefined)), set }));
        await draw("advanced");
        const name = appSettingsMessages.items.hardwareAcceleration.label;
        expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
        // Turned back to what this run started with: no restart owed.
        await act(async () => screen.getByRole("switch", { name }).click());
        expect(screen.getByRole("switch", { name }).getAttribute("aria-checked")).toBe("true");
        expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
        await act(async () => accept({ ...SNAPSHOT, hardwareAcceleration: true, restartPending: false }));
        expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
    });

    it("draws the values kept on this device at once, and swaps only what the app answers differently", async () => {
        window.localStorage.setItem("polaris.this-app.general", JSON.stringify({ ...SNAPSHOT, openAtLogin: true }));
        let answer: (value: unknown) => void = () => undefined;
        install(fakeBridge({ get: vi.fn(() => new Promise((resolve) => (answer = resolve))) }));
        await draw("general");
        expect(screen.getByRole("switch", { name: "Open with the computer" }).getAttribute("aria-checked")).toBe("true");
        expect(screen.getByRole("switch", { name: "Start in the tray" })).toBeTruthy();
        expect(document.querySelector("[data-placeholder]")).toBeNull();
        await act(async () => answer({ ...SNAPSHOT, openAtLogin: false }));
        expect(screen.getByRole("switch", { name: "Open with the computer" }).getAttribute("aria-checked")).toBe("false");
        expect(JSON.parse(window.localStorage.getItem("polaris.this-app.general")!).openAtLogin).toBe(false);
    });

    it("draws the category in its loading state, before the host answers for the route", async () => {
        window.localStorage.setItem("polaris.this-app.window", JSON.stringify({ ...SNAPSHOT, minimizeToTray: false }));
        install(fakeBridge({ get: vi.fn(() => new Promise(() => undefined)) }));
        route.pathname = "/account/app/window";
        render(
            <MessagesWrapper>
                <CategoryLoading />
            </MessagesWrapper>
        );
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.getByRole("heading", { name: appSettingsMessages.categories.window.title })).toBeTruthy();
        expect(screen.getByRole("switch", { name: "Minimize to tray" }).getAttribute("aria-checked")).toBe("false");
    });

    it("puts a kept value back when the app refuses the change", async () => {
        window.localStorage.setItem("polaris.this-app.window", JSON.stringify(SNAPSHOT));
        install(fakeBridge({ get: vi.fn(() => new Promise(() => undefined)), set: vi.fn(async () => null) }));
        await draw("window");
        await act(async () => screen.getByRole("switch", { name: "Minimize to tray" }).click());
        expect(screen.getByRole("switch", { name: "Minimize to tray" }).getAttribute("aria-checked")).toBe("true");
        expect(JSON.parse(window.localStorage.getItem("polaris.this-app.window")!).minimizeToTray).toBe(true);
    });

    it("keeps the update check on Downloads for a connection when the page was opened offline", async () => {
        const checkForUpdates = vi.fn(async () => ({ kind: "current" }));
        install({ ...fakeBridge(), version: "0.1.92", checkForUpdates });
        network.online = false;
        render(
            <MessagesWrapper>
                <ThisDeviceApp />
            </MessagesWrapper>
        );
        expect(screen.getByText("Polaris 0.1.92")).toBeTruthy();
        const check = screen.getByRole("button", { name: "Check for updates" });
        expect(check.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getAllByText(appSettingsMessages.updates.offline).length).toBeGreaterThan(0);
        await act(async () => check.click());
        expect(checkForUpdates).not.toHaveBeenCalled();
    });

    it("offers the restart into a downloaded update on Downloads, offline too", async () => {
        const installUpdate = vi.fn(async () => undefined);
        install({
            ...fakeBridge(),
            version: "0.1.92",
            installUpdate,
            updateReady: vi.fn(async () => ({ version: "0.1.93" }))
        });
        network.online = false;
        render(
            <MessagesWrapper>
                <ThisDeviceApp />
            </MessagesWrapper>
        );
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => screen.getByRole("button", { name: "Restart now" }).click());
        expect(installUpdate).toHaveBeenCalled();
    });

    it("heads General with the app's version and its check, once", async () => {
        install({ ...fakeBridge(), version: "0.1.109", checkForUpdates: vi.fn(async () => ({ kind: "current" })) });
        render(
            <MessagesWrapper>
                <AppSettingsScreen category="general" />
            </MessagesWrapper>
        );
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.getAllByText("Polaris 0.1.109")).toHaveLength(1);
        expect(screen.getAllByRole("button", { name: "Check for updates" })).toHaveLength(1);
    });

    it("leaves the version off the other categories", async () => {
        install({ ...fakeBridge(), version: "0.1.109", checkForUpdates: vi.fn() });
        render(
            <MessagesWrapper>
                <AppSettingsScreen category="window" />
            </MessagesWrapper>
        );
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.queryByText("Polaris 0.1.109")).toBeNull();
    });

    it("draws nothing on Downloads inside the desktop app, whose own card names the version", () => {
        install({ ...fakeBridge(), version: "0.1.109", checkForUpdates: vi.fn() });
        const { container } = render(
            <MessagesWrapper>
                <ThisDeviceApp desktop={false} />
            </MessagesWrapper>
        );
        expect(container.textContent).toBe("");
    });

    it("draws nothing for the app on Downloads in a browser", () => {
        const { container } = render(
            <MessagesWrapper>
                <ThisDeviceApp />
            </MessagesWrapper>
        );
        expect(container.textContent).toBe("");
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
