// @vitest-environment jsdom

/**
 * The TV install dialog while it waits on the TV: the one instruction for that
 * TV's own menus (sent by the desktop app, or read from the checker's data for
 * the platform answered before Install), the prompt to accept, a Stop that
 * ends the wait, and the names TVs announced beside their addresses.
 */

import userEvent from "@testing-library/user-event";
import type { DesktopTvState } from "@/lib/desktop-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper, withMessages } from "../setup/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TvWaitingNote, type TvMenus } from "@/app/(app)/account/downloads/tv-waiting";

const GOOGLE_TV: TvMenus = {
    about: "Settings > System > About",
    press: "Build",
    presses: 7,
    developer: "Settings > System > Developer options",
    switches: ["USB debugging", "Wireless debugging"]
};
const FIRE_TV: TvMenus = {
    about: "Settings > My Fire TV > About",
    press: "the device name",
    presses: 7,
    developer: "Settings > My Fire TV > Developer options",
    switches: ["ADB debugging"]
};

// The dialog reads platform menus through core's debuggingFor(); the checker is not under test here.
vi.mock("@polaris/core/tv-compat", () => ({
    debuggingFor: (platform: string) => (platform === "fire-os" ? FIRE_TV : undefined)
}));
vi.mock("@polaris/ui/tv-checker", () => ({ TvChecker: () => null }));
vi.mock("@polaris/ui/download-card", () => ({
    DownloadCard: ({ children }: { children: unknown }) => children
}));

let listener: ((state: DesktopTvState) => void) | null = null;
const cancel = vi.fn(async () => null);
const BASE: DesktopTvState = {
    phase: "ready",
    found: [],
    usb: null,
    usbListing: false,
    outcome: null,
    backup: null,
    closed: null
};
vi.mock("@/lib/desktop-bridge", () => ({
    desktopBridge: () => ({
        tv: {
            state: async () => BASE,
            find: async () => BASE,
            cancel,
            start: async () => true,
            onState: (next: (state: DesktopTvState) => void) => {
                listener = next;
                return () => (listener = null);
            }
        }
    })
}));

afterEach(() => {
    cleanup();
    listener = null;
    cancel.mockClear();
});

describe("TvWaitingNote", () => {
    it("names the TV's own menus, press count and switches while it waits", () => {
        render(<TvWaitingNote menus={GOOGLE_TV} step="debugging" waiting />, {
            wrapper: MessagesWrapper
        });
        expect(
            screen.getByText(
                "On the TV, open Settings > System > About and press OK on Build 7 times. Then in Settings > System > Developer options, turn on USB debugging and Wireless debugging."
            )
        ).toBeTruthy();
        expect(screen.getByText("The install carries on by itself once it is on.")).toBeTruthy();
        // Wireless debugging needs a pairing code the app cannot type in yet; a cable works.
        expect(screen.getByText(/needs a pairing code/)).toBeTruthy();
    });

    it("reads as a step before Install when nothing waits yet, with one switch and no pairing note", () => {
        render(<TvWaitingNote menus={FIRE_TV} step="debugging" waiting={false} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText(/^Before you start, on the TV: open Settings > My Fire TV > About/)).toBeTruthy();
        expect(screen.getByText(/turn on ADB debugging\.$/)).toBeTruthy();
        expect(screen.queryByText(/carries on by itself/)).toBeNull();
        expect(screen.queryByText(/pairing code/)).toBeNull();
    });

    it("asks to accept the prompt, and says it in Spanish", () => {
        render(withMessages(<TvWaitingNote menus={GOOGLE_TV} step="prompt" waiting />, "es-ES"));
        expect(screen.getByText(/^En la TV, elige Permitir\./)).toBeTruthy();
    });

    it("joins the switches in Spanish", () => {
        render(withMessages(<TvWaitingNote menus={GOOGLE_TV} step="debugging" waiting />, "es-ES"));
        expect(screen.getByText(/activa USB debugging y Wireless debugging\.$/)).toBeTruthy();
    });
});

describe("the install dialog", () => {
    async function openDialog() {
        window.history.replaceState(null, "", "/account/downloads?tv=install");
        const { TvOffer } = await import("@/app/(app)/account/downloads/tv-offer");
        render(<TvOffer download={null} released={Promise.resolve(true)} />, {
            wrapper: MessagesWrapper
        });
        await screen.findByText("Polaris TV", { exact: false });
    }

    it("shows the instruction the app sent while it waits, and Stop cancels the wait", async () => {
        await openDialog();
        act(() =>
            listener?.({ ...BASE, phase: "connecting", waiting: { step: "debugging", ...GOOGLE_TV } })
        );
        expect(await screen.findByText("Waiting for the TV...")).toBeTruthy();
        expect(screen.getByText(/press OK on Build 7 times/)).toBeTruthy();
        await userEvent.click(screen.getByRole("button", { name: "Stop" }));
        expect(cancel).toHaveBeenCalled();
    });

    it("shows the prompt step instead of the phase text once the TV asks", async () => {
        await openDialog();
        act(() => listener?.({ ...BASE, phase: "allow", waiting: { step: "prompt", ...GOOGLE_TV } }));
        expect(await screen.findByText(/Tick Always allow from this computer/)).toBeTruthy();
        expect(screen.queryByText("On the TV, choose Allow when it asks to allow USB debugging.")).toBeNull();
    });

    it("lists a found TV by the name it announced, beside its address", async () => {
        await openDialog();
        act(() =>
            listener?.({
                ...BASE,
                found: ["192.168.1.40", "192.168.1.51"],
                named: { "192.168.1.40": "Living Room TV" }
            })
        );
        expect(await screen.findByRole("button", { name: /Living Room TV - 192\.168\.1\.40/ })).toBeTruthy();
        expect(screen.getByRole("button", { name: "192.168.1.51" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    });
});
