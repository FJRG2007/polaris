// @vitest-environment jsdom
/**
 * The plugins store draws its cards with the marketplace's own preview: the
 * plugin's photograph when the catalog carries one, its designed placeholder
 * when not, and card-shaped skeletons while the desktop app answers. The grid
 * takes its column count from its own width, never the viewport's, so a card
 * is the same size on the dashboard, an account page and the public site.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readPluginCatalog, readPluginManifest } from "@polaris/core/device-plugins";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useLocale: () => "en-US",
    useTranslations: () => (key: string, values?: Record<string, string>) => (values?.name ? `${key}:${values.name}` : key)
}));
const desktop = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@/components/desktop-app", () => ({ useDesktopBridge: () => desktop.bridge }));
vi.mock("@polaris/ui", async (importOriginal) => ({ ...(await importOriginal<object>()), useToast: () => ({ show: vi.fn() }) }));
const confirmed = vi.hoisted(() => ({ answer: false, asked: [] as string[] }));
vi.mock("@/components/confirm-dialog", () => ({
    useConfirm: () => [
        async (options: { title: string }) => {
            confirmed.asked.push(options.title);
            return confirmed.answer;
        },
        null
    ]
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { PluginsStore } = await import("@/app/(app)/account/plugins/plugins-view");
const { resetPluginsCache } = await import("@/lib/device-plugins-client");
const { StoreSection, STORE_GRID } = await import("@polaris/ui/store-layout");

const raw = JSON.parse(readFileSync(join(process.cwd(), "../../../clients/device-plugins/hercules-stream100/manifest.json"), "utf8")) as Record<string, unknown>;
const manifest = readPluginManifest(raw)!;
const RELEASE = "https://github.com/FJRG2007/polaris/releases/download/device-addons/";

function catalogWith(extra: Record<string, unknown>) {
    return {
        schema: 1,
        issued: "2026-11-01T00:00:00.000Z",
        plugins: [
            {
                ...raw,
                packages: { "win32-x64": { url: `${RELEASE}a.zip`, sha256: "a".repeat(64), size: 10 } },
                published: "2026-11-01T00:00:00.000Z",
                ...extra
            }
        ]
    };
}

function open(catalog: unknown, answer: Promise<void> = Promise.resolve()) {
    desktop.bridge = {
        plugins: {
            get: async () => {
                await answer;
                return { platform: "win32-x64", appVersion: "0.1.200", catalog, installed: [], installing: {} };
            },
            onChange: () => () => undefined,
            settings: async () => ({}),
            setSetting: vi.fn(async () => ({})),
            setEnabled: vi.fn(async () => true),
            uninstall: vi.fn(async () => true)
        }
    };
    return render(<PluginsStore />);
}

afterEach(() => {
    cleanup();
    resetPluginsCache();
    confirmed.answer = false;
    confirmed.asked = [];
    router.push.mockClear();
});

/** One installed copy of the plugin, as the desktop app reports it. */
function installedCopy(over: Record<string, unknown> = {}) {
    return { id: manifest.id, version: manifest.version, enabled: true, granted: manifest.permissions, manifest: raw, update: null, autoUpdate: null, consent: [], failed: null, run: { state: "sleeping" }, ...over };
}

/** A desktop app with the plugin installed; its `refresh` brings `afterCheck` and says so, as the real one does. */
function openInstalled(
    installed: Record<string, unknown>,
    { afterCheck, outcome = "updated", installing = {} }: { afterCheck?: Record<string, unknown>; outcome?: string; installing?: Record<string, unknown> } = {}
) {
    let current = installed;
    const listeners = new Set<() => void>();
    const plugins = {
        get: vi.fn(async () => ({ platform: "win32-x64", appVersion: "0.1.200", catalog: catalogWith({}), autoUpdate: true, installed: [current], installing })),
        refresh: vi.fn(async () => {
            if (afterCheck) current = afterCheck;
            for (const listener of listeners) listener();
            return outcome;
        }),
        onChange: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        settings: async () => ({}),
        setSetting: vi.fn(async () => ({})),
        setEnabled: vi.fn(async () => true),
        setAutoUpdate: vi.fn(async () => true),
        uninstall: vi.fn(async () => true)
    };
    desktop.bridge = { plugins };
    render(<PluginsStore />);
    return plugins;
}

async function openMenu() {
    const trigger = await screen.findByLabelText(`plugins.card.more:${manifest.name}`);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    return screen.findAllByRole("menuitem");
}

describe("the plugins store's cards", () => {
    it("keeps a catalog entry's picture", () => {
        const catalog = readPluginCatalog(catalogWith({ picture: `${RELEASE}hercules-stream100-0.1.5-picture.webp` }));
        expect(catalog?.plugins[0]?.picture).toBe(`${RELEASE}hercules-stream100-0.1.5-picture.webp`);
        expect(readPluginCatalog(catalogWith({}))?.plugins[0]?.picture).toBeUndefined();
    });

    it("shows the photograph when the catalog has one", async () => {
        const picture = `${RELEASE}hercules-stream100-0.1.5-picture.webp`;
        const { container } = open(catalogWith({ picture }));
        const image = await screen.findByAltText(`plugins.card.picture:${manifest.name}`);
        expect(image.getAttribute("src")).toBe(picture);
        expect(container.querySelector('[data-preview="photo"]')).not.toBeNull();
        expect(container.querySelector('[data-preview="placeholder"]')).toBeNull();
    });

    it("falls back to the designed placeholder without one", async () => {
        const { container } = open(catalogWith({}));
        // Inside the aria-hidden picture link: the name below is what a keyboard reaches.
        await screen.findByRole("img", { name: `plugins.card.picture:${manifest.name}`, hidden: true });
        const placeholder = container.querySelector<HTMLElement>('[data-preview="placeholder"]');
        expect(placeholder).not.toBeNull();
        expect(placeholder?.style.backgroundColor).not.toBe("");
    });

    it("draws card-shaped skeletons in the grid while the app answers", async () => {
        let answer!: () => void;
        const { container } = open(catalogWith({}), new Promise<void>((resolve) => (answer = resolve)));
        const skeletons = container.querySelectorAll("[data-store-skeleton]");
        expect(skeletons.length).toBeGreaterThan(0);
        expect(skeletons[0]?.parentElement?.className).toBe(STORE_GRID.shelf);
        answer();
        await waitFor(() => expect(container.querySelector("[data-store-skeleton]")).toBeNull());
    });
});

describe("the store grid", () => {
    it("counts columns by its own width, not the viewport's", () => {
        for (const featured of [false, true]) {
            const { container } = render(
                <StoreSection label="Shelf" featured={featured}>
                    <div />
                </StoreSection>
            );
            const section = container.querySelector("section")!;
            const grid = section.querySelector("div")!;
            expect(section.className).toContain("[container-type:inline-size]");
            expect(grid.className).toMatch(/\[@container\(min-width:\d+rem\)\]:grid-cols-2/);
            expect(grid.className).not.toMatch(/(^|\s)(sm|md|lg|xl|2xl):grid-cols-/);
            cleanup();
        }
    });
});
describe("an installed plugin's card menu", () => {
    it("offers what the apps' cards do: details, settings, update, automatic updates, turning off and uninstall", async () => {
        openInstalled(installedCopy({ update: "9.9.9" }));
        const items = await openMenu();
        expect(items.map((item) => item.textContent)).toEqual([
            "plugins.card.details",
            "plugins.detail.settings",
            "plugins.card.update",
            "plugins.menu.autoOff",
            "plugins.menu.turnOff",
            "plugins.detail.uninstall"
        ]);
        fireEvent.click(items[1]!);
        expect(router.push).toHaveBeenCalledWith(`/account/plugins/${manifest.id}#settings`);
    });

    it("offers only its details before it is installed", async () => {
        open(catalogWith({}));
        const items = await openMenu();
        expect(items.map((item) => item.textContent)).toEqual(["plugins.card.details"]);
    });

    it("switches automatic updates and the plugin itself through the desktop app", async () => {
        const plugins = openInstalled(installedCopy({ autoUpdate: false, enabled: false }));
        let items = await openMenu();
        fireEvent.click(items.find((item) => item.textContent === "plugins.menu.autoOn")!);
        expect(plugins.setAutoUpdate).toHaveBeenCalledWith(manifest.id, true);
        items = await openMenu();
        fireEvent.click(items.find((item) => item.textContent === "plugins.menu.turnOn")!);
        expect(plugins.setEnabled).toHaveBeenCalledWith(manifest.id, true);
    });

    it("uninstalls only after the dialog is confirmed", async () => {
        const plugins = openInstalled(installedCopy());
        fireEvent.click((await openMenu()).find((item) => item.textContent === "plugins.detail.uninstall")!);
        await waitFor(() => expect(confirmed.asked).toEqual([`plugins.detail.uninstallTitle:${manifest.name}`]));
        expect(plugins.uninstall).not.toHaveBeenCalled();

        confirmed.answer = true;
        fireEvent.click((await openMenu()).find((item) => item.textContent === "plugins.detail.uninstall")!);
        await waitFor(() => expect(plugins.uninstall).toHaveBeenCalledWith(manifest.id));
    });

    it("keeps turning off and uninstall switched off, with the reason, while it installs", async () => {
        openInstalled(installedCopy(), { installing: { [manifest.id]: { received: 1, total: 2 } } });
        const items = await openMenu();
        for (const text of ["plugins.menu.turnOffplugins.menu.busy", "plugins.detail.uninstallplugins.menu.busy"]) {
            const item = items.find((candidate) => candidate.textContent === text);
            expect(item?.getAttribute("aria-disabled")).toBe("true");
        }
    });
});

describe("checking for updates", () => {
    it("says Checking..., then shows the newer version on the card at once", async () => {
        let finish!: () => void;
        const plugins = openInstalled(installedCopy(), { afterCheck: installedCopy({ update: "9.9.9" }) });
        const inner = plugins.refresh.getMockImplementation()!;
        plugins.refresh.mockImplementation(async () => {
            await new Promise<void>((resolve) => (finish = resolve));
            return inner();
        });
        await screen.findByLabelText(`plugins.card.more:${manifest.name}`);
        expect(screen.queryByRole("button", { name: "plugins.card.update" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "plugins.check.action" }));
        const checking = await screen.findByRole("button", { name: "plugins.check.running" });
        expect(checking.hasAttribute("disabled")).toBe(true);
        await act(async () => finish());

        await waitFor(() => expect(screen.getByRole("status").textContent).toBe("plugins.check.found"));
        expect(await screen.findByRole("button", { name: "plugins.card.update" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "plugins.check.action" })).toBeTruthy();
    });

    it("says everything is up to date when the list has nothing newer", async () => {
        openInstalled(installedCopy(), { outcome: "unchanged" });
        fireEvent.click(await screen.findByRole("button", { name: "plugins.check.action" }));
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe("plugins.check.none"));
    });

    it("says the list could not be reached instead of claiming it is up to date", async () => {
        openInstalled(installedCopy(), { outcome: "failed" });
        fireEvent.click(await screen.findByRole("button", { name: "plugins.check.action" }));
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe("plugins.check.failed"));
    });
});
