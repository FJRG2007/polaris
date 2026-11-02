/**
 * The Install button exists only where the app can run the line: inside the
 * desktop app, on the system the line is for. Cancelling says nothing, and a
 * refusal is shown as the script said it.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../../../packages/ui/src/i18n", () => ({ useTranslations: () => (key: string) => key }));

const { DesktopInstall } = await import("@polaris/ui/account-downloads/desktop-install");

function bridge(installTool?: (input: unknown) => Promise<unknown>): void {
    (window as { polarisDesktop?: unknown }).polarisDesktop = { platform: "win32", installTool };
}

function line(platform: "windows" | "macos" = "windows") {
    return render(<DesktopInstall tool="cli" platform={platform} done="all done" />);
}

afterEach(() => {
    cleanup();
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
});

describe("the Install button", () => {
    it("is not there in a browser, in an older app, or for another system", () => {
        expect(line().container.textContent).toBe("");
        cleanup();
        bridge();
        expect(line().container.textContent).toBe("");
        cleanup();
        bridge(async () => ({ ok: true }));
        expect(line("macos").container.textContent).toBe("");
    });

    it("installs and says what is left", async () => {
        const install = vi.fn(async () => ({ ok: true }));
        bridge(install);
        line();
        fireEvent.click(await screen.findByRole("button"));
        expect(await screen.findByText("all done")).toBeTruthy();
        expect(install).toHaveBeenCalledWith({ tool: "cli", browser: undefined });
    });

    it("says nothing when the confirmation was cancelled", async () => {
        bridge(async () => ({ ok: false, reason: "cancelled" }));
        const { container } = line();
        fireEvent.click(await screen.findByRole("button"));
        await waitFor(() => expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false));
        expect(container.querySelector("p")).toBeNull();
    });

    it("shows a refusal as it came", async () => {
        bridge(async () => ({ ok: false, reason: "failed", said: "Node 20 is required" }));
        line();
        fireEvent.click(await screen.findByRole("button"));
        expect(await screen.findByText("Node 20 is required")).toBeTruthy();
    });

    it.each([
        ["unsupported", "downloads.install.unsupported"],
        ["busy", "downloads.install.busy"],
        ["failed", "downloads.install.failed"],
        ["refused", "downloads.install.failed"],
        ["from a newer app", "downloads.install.failed"]
    ])("words the reason %s in the reader's language", async (reason, key) => {
        bridge(async () => ({ ok: false, reason }));
        line();
        fireEvent.click(await screen.findByRole("button"));
        expect(await screen.findByText(key)).toBeTruthy();
    });

    it("words a bridge that failed outright", async () => {
        bridge(async () => {
            throw new Error("gone");
        });
        line();
        fireEvent.click(await screen.findByRole("button"));
        expect(await screen.findByText("downloads.install.failed")).toBeTruthy();
    });
});
