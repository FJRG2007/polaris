// @vitest-environment jsdom

/**
 * The desktop app's "restart to update" in the top bar: absent in a browser, in
 * an app older than it, and while no update waits; shown once one is ready -
 * asked for or heard - and restarting the app on a press, with the press shown
 * as pending and a refusal said in a toast.
 */

import { ToastProvider } from "@polaris/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DesktopUpdateButton, RESTART_WAIT_MS } from "@/components/desktop-update-button";
import { readDesktopUpdate, type DesktopUpdate, type PolarisDesktop } from "@/lib/desktop-bridge";
import { withMessages } from "../setup/i18n";

const LABEL = /Polaris 0\.1\.3 is ready/;

function fakeBridge(overrides: Partial<PolarisDesktop> = {}): PolarisDesktop {
    return {
        version: "0.1.2",
        platform: "win32",
        notify: vi.fn(async () => true),
        closeNotice: vi.fn(async () => undefined),
        pickFolder: vi.fn(async () => null),
        pushLocal: vi.fn(async () => ({ ok: true as const })),
        openWindow: vi.fn(async () => ({ ok: true as const })),
        ...overrides
    };
}

/** A bridge with the update channels, and a way to tell the page a change. */
function updatingBridge(ready: DesktopUpdate | null, install = vi.fn(async () => ({ ok: true as const }))) {
    let listener: ((update: DesktopUpdate | null) => void) | null = null;
    const stop = vi.fn();
    const bridge = fakeBridge({
        updateReady: vi.fn(async () => ready),
        onUpdateReady: vi.fn((heard) => {
            listener = heard;
            return stop;
        }),
        installUpdate: install
    });
    return { bridge, install, stop, tell: (update: DesktopUpdate | null) => act(() => listener?.(update)) };
}

function install(value: unknown): void {
    Object.defineProperty(window, "polarisDesktop", { value, configurable: true, writable: true });
}

async function show() {
    const view = render(withMessages(<ToastProvider><DesktopUpdateButton /></ToastProvider>));
    await act(async () => undefined);
    return view;
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
});

describe("DesktopUpdateButton", () => {
    it("renders nothing in a browser", async () => {
        await show();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("renders nothing in an app older than the update channels", async () => {
        install(fakeBridge());
        await show();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("renders nothing, throws nothing and claims nothing in an app with only part of them", async () => {
        const onUpdateReady = vi.fn(() => () => undefined);
        install(fakeBridge({ onUpdateReady, updateReady: vi.fn(async () => ({ version: "0.1.3" })) }));
        await show();
        expect(screen.queryByRole("button")).toBeNull();
        // Listening is how a page tells the app it draws the button; one that
        // could not restart must not tell it that.
        expect(onUpdateReady).not.toHaveBeenCalled();
    });

    it("renders nothing when the app fails to answer", async () => {
        const app = updatingBridge(null);
        install({ ...app.bridge, updateReady: vi.fn(async () => Promise.reject(new Error("gone"))) });
        await show();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("renders nothing while no update waits", async () => {
        install(updatingBridge(null).bridge);
        await show();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("shows the update the app already has ready, and restarts into it", async () => {
        const { bridge, install: restart } = updatingBridge({ version: "0.1.3" });
        install(bridge);
        await show();
        const button = screen.getByRole("button", { name: LABEL });
        expect(button.getAttribute("title")).toMatch(LABEL);
        expect(button.className).toContain("text-success");

        await act(async () => fireEvent.click(button));
        expect(restart).toHaveBeenCalledTimes(1);
        expect(button).toHaveProperty("disabled", true);
        expect(button.getAttribute("aria-busy")).toBe("true");
    });

    it("appears when the app says an update became ready, and goes when it says none", async () => {
        const app = updatingBridge(null);
        install(app.bridge);
        await show();
        expect(screen.queryByRole("button")).toBeNull();
        app.tell({ version: "0.1.3" });
        expect(screen.getByRole("button", { name: LABEL })).toBeTruthy();
        app.tell(null);
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("shows the same state in every place it is drawn", async () => {
        const listeners: ((update: DesktopUpdate | null) => void)[] = [];
        install(
            fakeBridge({
                updateReady: vi.fn(async () => null),
                onUpdateReady: vi.fn((listener) => {
                    listeners.push(listener);
                    return () => undefined;
                }),
                installUpdate: vi.fn(async () => ({ ok: true as const }))
            })
        );
        render(withMessages(<><DesktopUpdateButton /><DesktopUpdateButton /></>));
        await act(async () => undefined);
        act(() => listeners.forEach((listener) => listener({ version: "0.1.3" })));
        expect(screen.getAllByRole("button", { name: LABEL })).toHaveLength(2);
        act(() => listeners.forEach((listener) => listener(null)));
        expect(screen.queryAllByRole("button")).toHaveLength(0);
    });

    it("stops listening when it leaves the page", async () => {
        const app = updatingBridge({ version: "0.1.3" });
        install(app.bridge);
        const view = await show();
        view.unmount();
        expect(app.stop).toHaveBeenCalledTimes(1);
    });

    it("says a refused restart and can be pressed again", async () => {
        const refuse = vi.fn(async () => ({ ok: false as const, error: "There is no update waiting to be installed." }));
        install(updatingBridge({ version: "0.1.3" }, refuse as never).bridge);
        await show();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: LABEL })));
        expect(screen.getByText("There is no update waiting to be installed.")).toBeTruthy();
        expect(screen.getByRole("button", { name: LABEL })).toHaveProperty("disabled", false);
    });

    it("can be pressed again when the app did not restart after all", async () => {
        vi.useFakeTimers();
        const restart = vi.fn(async () => ({ ok: true as const }));
        install(updatingBridge({ version: "0.1.3" }, restart).bridge);
        await show();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: LABEL })));
        expect(screen.getByRole("button", { name: LABEL })).toHaveProperty("disabled", true);
        await act(async () => vi.advanceTimersByTime(RESTART_WAIT_MS));
        expect(screen.getByRole("button", { name: LABEL })).toHaveProperty("disabled", false);
    });

    it("ignores an update state that is not one", async () => {
        install(updatingBridge({ version: 3 } as never).bridge);
        await show();
        expect(screen.queryByRole("button")).toBeNull();
        expect(readDesktopUpdate({ version: "" })).toBeNull();
        expect(readDesktopUpdate("0.1.3")).toBeNull();
        expect(readDesktopUpdate({ version: "0.1.3" })).toEqual({ version: "0.1.3" });
    });

    it("reads in Spanish", async () => {
        install(updatingBridge({ version: "0.1.3" }).bridge);
        render(withMessages(<DesktopUpdateButton />, "es-ES"));
        await act(async () => undefined);
        expect(screen.getByRole("button", { name: /Polaris 0\.1\.3 está lista/ })).toBeTruthy();
    });
});
