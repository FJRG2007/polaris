// @vitest-environment jsdom
/**
 * The Stream 100's settings are edited on a drawing of the device: its knobs
 * (turn and press) and buttons where they sit, the actions beside it. An
 * action dragged onto a control is saved to that control's setting, a control
 * dragged onto another of its kind swaps the two, and the same is done without
 * a pointer by selecting a control and pressing an action - all through the
 * settings section's one save path.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPluginManifest, readPluginSettingValues } from "@polaris/core/device-plugins";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useLocale: () => "es-ES",
    useTranslations: () => (key: string, values?: Record<string, string>) => (values ? `${key}(${Object.values(values).join("|")})` : key)
}));
const desktop = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@/components/desktop-app", () => ({ useDesktopBridge: () => desktop.bridge }));
vi.mock("@polaris/ui", async (importOriginal) => ({ ...(await importOriginal<object>()), useToast: () => ({ show: vi.fn() }) }));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => [async () => false, null] }));

const { PluginPage } = await import("@/app/(app)/account/plugins/plugins-view");
const { replicaDrop, replicaLayout } = await import("@/app/(app)/account/plugins/device-replica");
const { resetPluginsCache, resetPluginSettingsCache } = await import("@/lib/device-plugins-client");

const raw = JSON.parse(readFileSync(join(process.cwd(), "../../../clients/device-plugins/hercules-stream100/manifest.json"), "utf8")) as Record<string, unknown>;
const manifest = readPluginManifest(raw)!;

function open(setSetting: (id: string, key: string, value: unknown) => Promise<unknown>) {
    desktop.bridge = {
        plugins: {
            get: async () => ({
                platform: "win32-x64",
                appVersion: "0.1.89",
                catalog: null,
                installed: [{ id: manifest.id, version: manifest.version, enabled: true, granted: [], manifest: raw, update: null, run: { state: "sleeping" } }],
                installing: {}
            }),
            onChange: () => () => undefined,
            settings: async () => ({}),
            setSetting,
            setEnabled: vi.fn(async () => true),
            uninstall: vi.fn(async () => true)
        }
    };
    return render(<PluginPage id={manifest.id} />);
}

/** jsdom has no DataTransfer: what a drag carries is the component's own state, this only lets it be set. */
function transfer() {
    return { setData: vi.fn(), getData: () => "", effectAllowed: "all", dropEffect: "none" };
}

function dragOnto(from: Element, to: Element) {
    const dataTransfer = transfer();
    fireEvent.dragStart(from, { dataTransfer });
    fireEvent.dragOver(to, { dataTransfer });
    fireEvent.drop(to, { dataTransfer });
    fireEvent.dragEnd(from, { dataTransfer });
}

/** The app's side: it keeps what it is sent and answers with everything it holds, refusing the keys in `refuse`. */
function app(refuse: readonly string[] = []) {
    const held: Record<string, unknown> = {};
    return vi.fn(async (_id: string, key: string, value: unknown) => {
        if (refuse.includes(key)) return null;
        held[key] = value;
        return { ...held };
    });
}

afterEach(() => {
    cleanup();
    resetPluginsCache();
    resetPluginSettingsCache();
});

describe("the device replica", () => {
    const layout = replicaLayout(manifest)!;
    const values = readPluginSettingValues(manifest.settings, {});
    const slots = new Map(manifest.settings.filter((setting) => setting.kind === "choice" || setting.kind === "action").map((setting) => [setting.key, setting] as const));
    const slot = (key: string) => slots.get(key) as Parameters<typeof replicaDrop>[1];

    it("pairs each knob's turn with its press, in order, and keeps the buttons apart", () => {
        expect(layout.knobs.map((knob) => [knob.turn?.key, knob.press?.key])).toEqual([
            ["knob1", "press1"],
            ["knob2", "press2"],
            ["knob3", "press3"],
            ["knob4", "press4"]
        ]);
        expect(layout.buttons.map((button) => button.key)).toEqual(["button1", "button2", "button3", "button4"]);
        expect(replicaLayout({ settings: manifest.settings, groups: [] })).toBeNull();
    });

    it("lands an action only where it fits, and swaps two controls of one kind", () => {
        expect(replicaDrop({ from: "library", kind: "action", value: "call.share" }, slot("press2"), slots, values)).toEqual({ press2: "call.share" });
        expect(replicaDrop({ from: "library", kind: "action", value: "none" }, slot("button1"), slots, values)).toEqual({ button1: null });
        expect(replicaDrop({ from: "library", kind: "choice", value: "music" }, slot("knob1"), slots, values)).toEqual({ knob1: "music" });
        expect(replicaDrop({ from: "library", kind: "choice", value: "music" }, slot("button1"), slots, values)).toBeNull();
        expect(replicaDrop({ from: "library", kind: "action", value: "call.mic" }, slot("knob1"), slots, values)).toBeNull();
        expect(replicaDrop({ from: "library", kind: "choice", value: "nowhere" }, slot("knob1"), slots, values)).toBeNull();
        expect(replicaDrop({ from: "slot", key: "knob1" }, slot("knob4"), slots, values)).toEqual({ knob1: "output", knob4: "calls" });
        // A knob's press and a button both run an action, so they swap too.
        expect(replicaDrop({ from: "slot", key: "press1" }, slot("button2"), slots, values)).toEqual({ press1: "call.deafen", button2: null });
        expect(replicaDrop({ from: "slot", key: "knob1" }, slot("button2"), slots, values)).toBeNull();
        expect(replicaDrop({ from: "slot", key: "button1" }, slot("button1"), slots, values)).toBeNull();
    });

    it("saves an action dragged from the list onto a button", async () => {
        const setSetting = app();
        const view = open(setSetting);
        await screen.findByRole("region", { name: "Ruedas" });
        const library = screen.getByRole("complementary", { name: "plugins.replica.library" });
        dragOnto(within(library).getByRole("button", { name: "plugins.action.share" }), view.container.querySelector("#setting-button4")!);
        await waitFor(() => expect(setSetting).toHaveBeenCalledWith(manifest.id, "button4", "call.share"));
        expect(setSetting).toHaveBeenCalledTimes(1);
    });

    it("swaps two buttons dragged one onto the other, saving both", async () => {
        const setSetting = app();
        const view = open(setSetting);
        await screen.findByRole("region", { name: "Ruedas" });
        dragOnto(view.container.querySelector("#setting-button1")!, view.container.querySelector("#setting-button2")!);
        await waitFor(() => expect(setSetting).toHaveBeenCalledTimes(2));
        expect(setSetting).toHaveBeenCalledWith(manifest.id, "button1", "call.deafen");
        expect(setSetting).toHaveBeenCalledWith(manifest.id, "button2", "call.mic");
        expect(view.container.querySelector("#setting-button1")?.textContent).toContain("plugins.action.deafen");
    });

    it("puts the old values back when the app refuses one half of a swap", async () => {
        const setSetting = app(["knob2"]);
        const view = open(setSetting);
        await screen.findByRole("region", { name: "Ruedas" });
        dragOnto(view.container.querySelector("#setting-knob1")!, view.container.querySelector("#setting-knob2")!);
        // knob1 was taken, knob2 refused: knob1 is set back to what it held.
        await waitFor(() => expect(setSetting).toHaveBeenCalledWith(manifest.id, "knob1", "calls"));
        await waitFor(() => expect(view.container.querySelector("#setting-knob1")?.textContent).toContain("Llamadas"));
    });

    it("does the same with no pointer: select a control, then press an action", async () => {
        const setSetting = app();
        const view = open(setSetting);
        await screen.findByRole("region", { name: "Ruedas" });
        const press = view.container.querySelector<HTMLButtonElement>("#setting-press3")!;
        fireEvent.click(press);
        expect(press.getAttribute("aria-pressed")).toBe("true");
        const library = screen.getByRole("complementary", { name: "plugins.replica.library" });
        // A volume group does not fit a press: it is offered, but not usable there.
        expect(within(library).getByRole("button", { name: "Música" }).getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(within(library).getByRole("button", { name: "Música" }));
        fireEvent.click(within(library).getByRole("button", { name: "plugins.action.camera" }));
        await waitFor(() => expect(setSetting).toHaveBeenCalledWith(manifest.id, "press3", "call.camera"));
        expect(setSetting).toHaveBeenCalledTimes(1);
    });

    it("narrows the list to what is typed", async () => {
        open(app());
        await screen.findByRole("region", { name: "Ruedas" });
        const library = screen.getByRole("complementary", { name: "plugins.replica.library" });
        fireEvent.change(within(library).getByRole("textbox", { name: "plugins.replica.find" }), { target: { value: "músi" } });
        expect(within(library).getAllByRole("button").map((button) => button.textContent)).toEqual(["Música"]);
        fireEvent.change(within(library).getByRole("textbox", { name: "plugins.replica.find" }), { target: { value: "zzz" } });
        expect(within(library).getByText("plugins.replica.noMatch")).toBeTruthy();
    });
});
