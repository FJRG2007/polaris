// @vitest-environment jsdom

/**
 * "Check for updates" on the Desktop app page, inside the desktop app: absent in
 * a browser and in an app older than the check, and saying in words what the
 * app found - with a restart offered once the new version is installed.
 */

import { withMessages } from "../setup/i18n";
import { NativeAppOffer } from "@/components/installed-app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readDesktopUpdateCheck, type PolarisDesktop } from "@/lib/desktop-bridge";

function fakeBridge(overrides: Partial<PolarisDesktop> = {}): PolarisDesktop {
    return {
        version: "0.1.14",
        platform: "win32",
        notify: vi.fn(async () => true),
        closeNotice: vi.fn(async () => undefined),
        pickFolder: vi.fn(async () => null),
        pushLocal: vi.fn(async () => ({ ok: true as const })),
        openWindow: vi.fn(async () => ({ ok: true as const })),
        ...overrides
    };
}

function install(value: unknown): void {
    Object.defineProperty(window, "polarisDesktop", { value, configurable: true, writable: true });
}

async function show() {
    const view = render(
        withMessages(
            <NativeAppOffer>
                <p>downloads</p>
            </NativeAppOffer>
        )
    );
    await act(async () => undefined);
    return view;
}

afterEach(() => {
    cleanup();
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
});

describe("reading the app's answer", () => {
    it("keeps the known answers and turns anything else into a failed check", () => {
        expect(readDesktopUpdateCheck({ kind: "current", version: "0.1.14" })).toEqual({
            kind: "current",
            version: "0.1.14"
        });
        expect(readDesktopUpdateCheck({ kind: "failed", reason: "offline" })).toEqual({
            kind: "failed"
        });
        expect(readDesktopUpdateCheck({ kind: "ready" })).toEqual({ kind: "failed" });
        expect(readDesktopUpdateCheck(null)).toEqual({ kind: "failed" });
    });
});

describe("Check for updates on the Desktop app page", () => {
    it("is not offered in a browser", async () => {
        await show();
        expect(screen.getByText("downloads")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    });

    it("is not offered by an app older than the check", async () => {
        install(fakeBridge());
        await show();
        expect(screen.getByText(/version 0\.1\.14/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    });

    it("says the running version is the newest", async () => {
        const checkForUpdates = vi.fn(async () => ({ kind: "current", version: "0.1.14" }));
        install(fakeBridge({ checkForUpdates }));
        await show();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
        });
        expect(checkForUpdates).toHaveBeenCalledOnce();
        expect(screen.getByRole("status").textContent).toContain("0.1.14 is the newest version");
        expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
    });

    it("offers the restart once the new version is installed", async () => {
        const installUpdate = vi.fn(async () => ({ ok: true as const }));
        install(
            fakeBridge({
                checkForUpdates: vi.fn(async () => ({ kind: "ready", version: "0.1.15" })),
                installUpdate
            })
        );
        await show();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
        });
        expect(screen.getByRole("status").textContent).toContain("0.1.15 is installed");
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
        });
        expect(installUpdate).toHaveBeenCalledOnce();
    });

    it("says a restart that was refused", async () => {
        install(
            fakeBridge({
                checkForUpdates: vi.fn(async () => ({ kind: "ready", version: "0.1.15" })),
                installUpdate: vi.fn(async () => ({ ok: false as const, error: "nothing waiting" }))
            })
        );
        await show();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
        });
        expect(screen.getByRole("alert").textContent).toContain("Polaris could not restart");
    });

    it("says a check that threw could not be made", async () => {
        install(
            fakeBridge({
                checkForUpdates: vi.fn(async () => Promise.reject(new Error("ipc closed")))
            })
        );
        await show();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
        });
        expect(screen.getByRole("status").textContent).toContain("Could not check for updates");
    });
});
