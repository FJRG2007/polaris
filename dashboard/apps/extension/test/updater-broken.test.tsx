// @vitest-environment jsdom

/**
 * What the popup says when the install script's updater has stopped
 * (BUG-0022): the reason in words, the updater's own detail under it, and the
 * install line for this system to repair it, copied with one press.
 */

import { INSTALL_LINES } from "../src/lib/self-update";
import { UpdaterBroken } from "../src/entrypoints/popup/updater-broken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const writeText = vi.fn(async () => undefined);

function stubBrowser(os: string): void {
    vi.stubGlobal("browser", { runtime: { getPlatformInfo: async () => ({ os }) } });
}

beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("automatic updates that stopped", () => {
    it("says why, with the updater's own detail", async () => {
        stubBrowser("win");
        render(<UpdaterBroken trouble={{ reason: "digest", detail: "extension-v0.1.281", at: 0 }} />);
        await act(async () => undefined);
        expect(screen.getByText(/Automatic updates are not working: the download did not match/)).toBeTruthy();
        expect(screen.getByText("extension-v0.1.281")).toBeTruthy();
    });

    it("names when an updater that went quiet last ran", async () => {
        stubBrowser("mac");
        const at = Date.UTC(2026, 10, 23, 12);
        render(<UpdaterBroken trouble={{ reason: "stopped", detail: null, at }} />);
        await act(async () => undefined);
        expect(screen.getByText(new RegExp(`has not run since ${new Date(at).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))).toBeTruthy();
    });

    it("offers the PowerShell line on Windows and copies it", async () => {
        stubBrowser("win");
        render(<UpdaterBroken trouble={{ reason: "task", detail: null, at: 0 }} />);
        await act(async () => undefined);
        expect(screen.getByText(INSTALL_LINES.windows)).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Copy the install line" }));
        });
        expect(writeText).toHaveBeenCalledWith(INSTALL_LINES.windows);
    });

    it("offers the shell line on macOS and Linux", async () => {
        stubBrowser("linux");
        render(<UpdaterBroken trouble={{ reason: "unknown", detail: null, at: 0 }} />);
        await act(async () => undefined);
        expect(screen.getByText(INSTALL_LINES.unix)).toBeTruthy();
    });
});
