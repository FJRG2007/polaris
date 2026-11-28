// @vitest-environment jsdom
/**
 * The drawing of the device's screen on the plugin's page follows the device
 * live: it starts from the newest values the app holds, takes every change the
 * app pushes without a reload, and keeps a sample only before the device has
 * shown anything (or from an app older than live values).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@polaris/core/device-plugins";
import { act, cleanup, render, screen } from "@testing-library/react";
import { readPluginLive, usePluginLevels, usePluginLive, type PluginsBridge } from "@/lib/device-plugins-client";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useLocale: () => "en",
    useTranslations: () => (key: string) => key
}));

const { ScreenPreview } = await import("@/app/(app)/account/plugins/plugin-look");

const manifest = { settings: [{ key: "accentColor", kind: "color", label: { "en-US": "Bar" }, default: "" }] } as unknown as Pick<PluginManifest, "settings">;
const knobs = (calls: number | null, muted = false) => ({
    knobs: [
        { label: "Calls", volume: calls, muted },
        { label: "Music", volume: 20, muted: false },
        { label: "Games", volume: null, muted: false },
        { label: "Output", volume: 90, muted: false }
    ]
});

function Page({ bridge }: { bridge: Pick<PluginsBridge, "live" | "onLive"> | null }) {
    const live = usePluginLive(bridge, "stream");
    return <ScreenPreview manifest={manifest} values={{}} names={["Calls", "Music", "Games", "Output"]} live={live} />;
}

function liveBridge(first: unknown) {
    const listeners = new Set<(id: string, live: unknown) => void>();
    return {
        bridge: {
            live: vi.fn(async () => first),
            onLive: (listener: (id: string, live: unknown) => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            }
        },
        push: (id: string, live: unknown) => act(() => listeners.forEach((listener) => listener(id, live))),
        listeners
    };
}

afterEach(cleanup);

describe("the device's screen on its page", () => {
    it("starts from what the device shows and follows each change without a reload", async () => {
        const { bridge, push, listeners } = liveBridge(knobs(64));
        const view = render(<Page bridge={bridge} />);
        expect(await screen.findByText("64%")).toBeTruthy();
        expect(screen.getByText("20%")).toBeTruthy();
        expect(screen.getAllByText("-")).toHaveLength(1);
        push("stream", knobs(65));
        expect(screen.getByText("65%")).toBeTruthy();
        // Another plugin's values and a value of the wrong shape change nothing.
        push("pedal", knobs(10));
        push("stream", { knobs: [{ label: "Calls", volume: 400, muted: false }] });
        expect(screen.getByText("65%")).toBeTruthy();
        // A muted knob is drawn in the device's muted colour.
        push("stream", knobs(65, true));
        expect((screen.getByText("65%") as HTMLElement).style.color).toBe("rgb(235, 80, 80)");
        view.unmount();
        expect(listeners.size).toBe(0);
    });

    it("keeps a sample before the device shows anything and with an app older than live values", async () => {
        const { bridge } = liveBridge(null);
        render(<Page bridge={bridge} />);
        await act(async () => {});
        expect(screen.getByText("72%")).toBeTruthy();
        cleanup();
        render(<Page bridge={{} as Pick<PluginsBridge, "live" | "onLive">} />);
        expect(screen.getByText("72%")).toBeTruthy();
    });

    it("meters each channel only while the page is open and seen", async () => {
        const watched: boolean[] = [];
        const listeners = new Set<(id: string, levels: unknown) => void>();
        const bridge = {
            watchLive: vi.fn(async (_id: string, on: boolean) => {
                watched.push(on);
                return true;
            }),
            onLevels: (listener: (id: string, levels: unknown) => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            }
        };
        function Metered() {
            const levels = usePluginLevels(bridge, "stream");
            return <ScreenPreview manifest={manifest} values={{}} names={["Calls", "Music", "Games", "Output"]} levels={levels} />;
        }
        const view = render(<Metered />);
        expect(watched).toEqual([true]);
        expect(view.container.querySelector("[data-meter]")).toBeNull();
        act(() => listeners.forEach((listener) => listener("stream", [42, null, 0, 100])));
        const meter = (index: number) => (view.container.querySelector(`[data-meter="${index}"] > span`) as HTMLElement).style.height;
        expect([meter(0), meter(1), meter(3)]).toEqual(["42%", "0%", "100%"]);
        // A hidden tab stops the metering; seen again, it starts again.
        const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        act(() => void document.dispatchEvent(new Event("visibilitychange")));
        visibility.mockReturnValue("visible");
        act(() => void document.dispatchEvent(new Event("visibilitychange")));
        visibility.mockRestore();
        view.unmount();
        expect(watched).toEqual([true, false, true, false]);
        expect(listeners.size).toBe(0);
    });

    it("shows each button's action under its knob, as the device's action zone does, and no zone with none", () => {
        const view = render(<ScreenPreview manifest={manifest} values={{}} names={["Calls", "Music", "Games", "Output"]} actions={["Mute mic", "", "Start stream", ""]} />);
        expect(view.container.querySelector("[data-action='0']")?.textContent).toBe("Mute mic");
        expect(view.container.querySelector("[data-action='2']")?.textContent).toBe("Start stream");
        expect(view.container.querySelector("[data-action='1']")?.textContent).toBe("\u00a0");
        cleanup();
        const plain = render(<ScreenPreview manifest={manifest} values={{}} names={["Calls", "Music", "Games", "Output"]} actions={["", "", "", ""]} />);
        expect(plain.container.querySelector("[data-action]")).toBeNull();
    });

    it("reads only knobs of the right shape", () => {
        expect(readPluginLive(knobs(50))).toEqual(knobs(50));
        expect(readPluginLive({ knobs: [{ label: "x", volume: 101, muted: false }] })).toBeNull();
        expect(readPluginLive("nope")).toBeNull();
    });
});
