// @vitest-environment jsdom

/**
 * The devices screen opens on what it last showed and stays current by itself.
 *
 * - A cached screen is drawn at once - no skeleton - and the read that follows
 *   leaves it alone when nothing changed.
 * - A pushed change moves that device and nothing else, with no button pressed.
 * - A frame that is not a frame is ignored, not drawn.
 * - The stream is closed while the tab is hidden, and a reopen catches up.
 * - A push about a device being pressed does not flip it back mid-press.
 */

import "@/components/app-host/client";
import { account, device } from "./fixtures";
import { withMessages } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/** A stand-in EventSource the test drives by hand. */
class FakeSource {
    static CLOSED = 2;
    static opened: FakeSource[] = [];
    readyState = 1;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
        FakeSource.opened.push(this);
    }
    close() {
        this.readyState = FakeSource.CLOSED;
    }
    send(payload: unknown) {
        this.onmessage?.({
            data: typeof payload === "string" ? payload : JSON.stringify(payload)
        } as MessageEvent<string>);
    }
}

/** This Node's jsdom has no working localStorage, so one in memory stands in. */
const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
        clear: () => stored.clear()
    }
});

let listed: DeviceView[] = [];
let listCalls = 0;
let release: () => void = () => undefined;
let gate: Promise<void> = Promise.resolve();
let answer: (value: { device?: DeviceView; error?: string }) => void = () => undefined;

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    listDevicesAction: async () => {
        listCalls += 1;
        await gate;
        return { devices: listed, accounts: [account()] };
    },
    syncDevicesAction: async () => ({}),
    deviceHistoryAction: async () => ({ events: [] }),
    deviceUsageAction: async () => ({ used: [] }),
    operateDeviceAction: () =>
        new Promise((resolve) => {
            answer = resolve;
        })
}));

const { DevicesView } = await import("@polaris-app/places/src/screens/devices/devices-view");

let renders = 0;
function draw(cacheKey = `live-${(renders += 1)}`) {
    render(
        withMessages(
            <DevicesView
                places={[]}
                placeId="place-1"
                cacheKey={cacheKey}
                canControl
                canManage={false}
            />
        )
    );
}

function latest(): FakeSource {
    const source = FakeSource.opened.at(-1);
    if (!source) throw new Error("no stream was opened");
    return source;
}

beforeEach(() => {
    vi.stubGlobal("EventSource", FakeSource);
    FakeSource.opened = [];
    listCalls = 0;
    gate = Promise.resolve();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
});

describe("the devices screen, live", () => {
    it("draws the last screen at once and leaves it when nothing changed", async () => {
        listed = [device()];
        draw("cached");
        await screen.findByText("Desk lamp");
        cleanup();

        // The server is slow this time: the cached screen must not wait for it.
        gate = new Promise((resolve) => {
            release = resolve;
        });
        draw("cached");
        expect(screen.getByText("Desk lamp")).toBeTruthy();
        const row = screen.getByText("Desk lamp").closest("li");
        await act(async () => release());
        expect(screen.getByText("Desk lamp").closest("li")).toBe(row);
    });

    it("moves a device when the server pushes it, with no button pressed", async () => {
        listed = [device(), device({ id: "device-2", name: "Fan" })];
        draw();
        await screen.findByText("Desk lamp");
        const toggle = screen.getByRole("switch", { name: "Turn Desk lamp on or off" });
        expect(toggle.getAttribute("aria-checked")).toBe("false");

        await act(async () =>
            latest().send({
                kind: "devices",
                devices: [device({ state: "on" })],
                removed: [],
                seen: { ids: ["device-1", "device-2"], at: new Date().toISOString() }
            })
        );
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect(
            screen.getByRole("switch", { name: "Turn Fan on or off" }).getAttribute("aria-checked")
        ).toBe("false");
        expect(screen.getAllByText(/Last updated/).length).toBeGreaterThan(0);

        await act(async () =>
            latest().send({ kind: "devices", devices: [], removed: ["device-2"], seen: null })
        );
        expect(screen.queryByText("Fan")).toBeNull();
    });

    it("ignores a frame it cannot read", async () => {
        listed = [device()];
        draw();
        await screen.findByText("Desk lamp");
        await act(async () => {
            latest().send("not json");
            latest().send({ kind: "devices", devices: "nope" });
        });
        expect(screen.getByText("Desk lamp")).toBeTruthy();
    });

    it("closes while hidden and catches up when it comes back", async () => {
        listed = [device()];
        draw();
        await screen.findByText("Desk lamp");
        const first = latest();
        await act(async () => first.send({ kind: "ready" }));
        const before = listCalls;

        const visibility = vi.spyOn(document, "visibilityState", "get");
        visibility.mockReturnValue("hidden");
        await act(async () => document.dispatchEvent(new Event("visibilitychange")));
        expect(first.readyState).toBe(FakeSource.CLOSED);

        listed = [device({ state: "on" })];
        visibility.mockReturnValue("visible");
        await act(async () => document.dispatchEvent(new Event("visibilitychange")));
        const second = latest();
        expect(second).not.toBe(first);
        await act(async () => second.send({ kind: "ready" }));
        await waitFor(() =>
            expect(
                screen
                    .getByRole("switch", { name: "Turn Desk lamp on or off" })
                    .getAttribute("aria-checked")
            ).toBe("true")
        );
        expect(listCalls).toBe(before + 1);
        visibility.mockRestore();
    });

    it("does not flip a pressed switch back on a push read before the press", async () => {
        listed = [device()];
        draw();
        await screen.findByText("Desk lamp");
        const toggle = screen.getByRole("switch", { name: "Turn Desk lamp on or off" });
        fireEvent.click(toggle);
        await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

        await act(async () =>
            latest().send({
                kind: "devices",
                devices: [device({ state: "off", name: "Desk lamp" })],
                removed: [],
                seen: null
            })
        );
        expect(toggle.getAttribute("aria-checked")).toBe("true");

        await act(async () => answer({ device: device({ state: "on" }) }));
        expect(toggle.getAttribute("aria-checked")).toBe("true");
    });

    it("does not let a read that began before a push put the older state back", async () => {
        listed = [device()];
        draw();
        await screen.findByText("Desk lamp");
        await act(async () => latest().send({ kind: "ready" }));

        // A reconnect starts a reread that answers slowly, with the old state.
        gate = new Promise((resolve) => {
            release = resolve;
        });
        await act(async () => latest().send({ kind: "ready" }));
        await act(async () =>
            latest().send({
                kind: "devices",
                devices: [device({ state: "on" })],
                removed: [],
                seen: null
            })
        );
        const toggle = screen.getByRole("switch", { name: "Turn Desk lamp on or off" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        await act(async () => release());
        expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
});
