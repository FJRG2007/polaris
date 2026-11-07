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

const GOOGLE_TV_ES: TvMenus = {
    about: "Ajustes > Sistema > Información",
    press: "Compilación",
    presses: 7,
    developer: "Ajustes > Sistema > Opciones para desarrolladores",
    switches: ["Depuración por USB", "Depuración inalámbrica"]
};

// The dialog reads platform menus through core's debuggingFor() and debuggingById(); the checker is not under test here.
vi.mock("@polaris/core/tv-compat", () => ({
    debuggingFor: (platform: string) => (platform === "fire-os" ? FIRE_TV : undefined),
    debuggingById: (id: string, locale?: string) =>
        id === "google-tv" ? (locale?.startsWith("es") ? GOOGLE_TV_ES : GOOGLE_TV) : undefined
}));
vi.mock("@polaris/ui/tv-checker", () => ({ TvChecker: () => null }));
vi.mock("@polaris/ui/download-card", () => ({
    DownloadCard: ({ children }: { children: unknown }) => children
}));

let listener: ((state: DesktopTvState) => void) | null = null;
const cancel = vi.fn(async () => null);
const start = vi.fn(async (_input: unknown) => true);
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
            start,
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
    start.mockClear();
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
        // Wireless debugging pairs with a code, which the desktop app asks for after Install.
        expect(screen.getByText(/asks for its code/)).toBeTruthy();
    });

    it("reads as a step before Install when nothing waits yet, with one switch and no pairing note", () => {
        render(<TvWaitingNote menus={FIRE_TV} step="debugging" waiting={false} />, {
            wrapper: MessagesWrapper
        });
        expect(
            screen.getByText(/^Before you start, on the TV: open Settings > My Fire TV > About/)
        ).toBeTruthy();
        expect(screen.getByText(/turn on ADB debugging\.$/)).toBeTruthy();
        expect(screen.queryByText(/carries on by itself/)).toBeNull();
        expect(screen.queryByText(/asks for its code/)).toBeNull();
    });

    it("asks to accept the prompt, and says it in Spanish", () => {
        render(withMessages(<TvWaitingNote menus={GOOGLE_TV} step="prompt" waiting />, "es-ES"));
        expect(screen.getByText(/^En la TV, elige Permitir\./)).toBeTruthy();
    });

    it("joins the switches in Spanish", () => {
        render(
            withMessages(<TvWaitingNote menus={GOOGLE_TV_ES} step="debugging" waiting />, "es-ES")
        );
        expect(
            screen.getByText(/activa Depuración por USB y Depuración inalámbrica\.$/)
        ).toBeTruthy();
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
            listener?.({
                ...BASE,
                phase: "connecting",
                waiting: { step: "debugging", ...GOOGLE_TV }
            })
        );
        expect(await screen.findByText("Waiting for the TV...")).toBeTruthy();
        expect(screen.getByText(/press OK on Build 7 times/)).toBeTruthy();
        await userEvent.click(screen.getByRole("button", { name: "Stop" }));
        expect(cancel).toHaveBeenCalled();
    });

    it("reads the menus the app named in the account's language", async () => {
        window.history.replaceState(null, "", "/account/downloads?tv=install");
        const { TvOffer } = await import("@/app/(app)/account/downloads/tv-offer");
        render(withMessages(<TvOffer download={null} released={Promise.resolve(true)} />, "es-ES"));
        await screen.findByText("Polaris TV", { exact: false });
        act(() =>
            listener?.({
                ...BASE,
                phase: "connecting",
                waiting: { step: "debugging", steps: "google-tv", ...GOOGLE_TV }
            })
        );
        expect(
            await screen.findByText(/activa Depuración por USB y Depuración inalámbrica\.$/)
        ).toBeTruthy();
        expect(screen.queryByText(/USB debugging/)).toBeNull();
    });

    it("keeps the menus the app sent when their steps are not known here", async () => {
        await openDialog();
        act(() =>
            listener?.({
                ...BASE,
                phase: "connecting",
                waiting: { step: "debugging", steps: "unknown", ...GOOGLE_TV }
            })
        );
        expect(await screen.findByText(/press OK on Build 7 times/)).toBeTruthy();
    });

    it("shows the prompt step instead of the phase text once the TV asks", async () => {
        await openDialog();
        act(() =>
            listener?.({ ...BASE, phase: "allow", waiting: { step: "prompt", ...GOOGLE_TV } })
        );
        expect(await screen.findByText(/Tick Always allow from this computer/)).toBeTruthy();
        expect(
            screen.queryByText("On the TV, choose Allow when it asks to allow USB debugging.")
        ).toBeNull();
    });

    it("asks for the TV's pairing code here, sends it, and takes a new one after a wrong code", async () => {
        await openDialog();
        await userEvent.type(screen.getByLabelText("TV address"), "192.168.1.40");
        act(() => listener?.({ ...BASE, phase: "failed", outcome: "needs-pairing" }));
        const field = await screen.findByLabelText("Pairing code");
        const pair = screen.getByRole("button", { name: "Pair and install" });
        expect(pair.hasAttribute("disabled")).toBe(true);
        await userEvent.type(field, "12a3456");
        expect((field as HTMLInputElement).value).toBe("123456");
        await userEvent.click(pair);
        expect(start).toHaveBeenLastCalledWith({
            host: "192.168.1.40",
            mode: "system",
            home: true,
            code: "123456"
        });

        act(() => listener?.({ ...BASE, phase: "connecting", outcome: null }));
        act(() => listener?.({ ...BASE, phase: "failed", outcome: "pairing-refused" }));
        expect((screen.getByLabelText("Pairing code") as HTMLInputElement).value).toBe("");
        await userEvent.type(screen.getByLabelText("Pairing code"), "654321");
        expect((screen.getByLabelText("Pairing code") as HTMLInputElement).value).toBe("654321");
        await userEvent.click(screen.getByRole("button", { name: "Pair and install" }));
        expect(start).toHaveBeenLastCalledWith({
            host: "192.168.1.40",
            mode: "system",
            home: true,
            code: "654321"
        });
    });

    it("drops the code field for another address", async () => {
        await openDialog();
        await userEvent.type(screen.getByLabelText("TV address"), "192.168.1.40");
        act(() => listener?.({ ...BASE, phase: "failed", outcome: "needs-pairing" }));
        await screen.findByLabelText("Pairing code");
        await userEvent.clear(screen.getByLabelText("TV address"));
        await userEvent.type(screen.getByLabelText("TV address"), "192.168.1.41");
        expect(screen.queryByLabelText("Pairing code")).toBeNull();
        expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
    });

    it("installs as the TV's system by default, and sends home for apps that only read that", async () => {
        await openDialog();
        await userEvent.type(screen.getByLabelText("TV address"), "192.168.1.40");
        expect(
            screen.getByRole("radio", { name: "As the TV's system" }).getAttribute("aria-checked")
        ).toBe("true");
        await userEvent.click(screen.getByRole("button", { name: "Install" }));
        expect(start).toHaveBeenLastCalledWith({
            host: "192.168.1.40",
            mode: "system",
            home: true
        });

        await userEvent.click(screen.getByRole("radio", { name: "Only as an app" }));
        expect(screen.getByText("Installs it and changes nothing else on the TV.")).toBeTruthy();
        await userEvent.click(screen.getByRole("button", { name: "Install" }));
        expect(start).toHaveBeenLastCalledWith({ host: "192.168.1.40", mode: "app", home: false });
    });

    it("lists what the TV allowed, and leaves out a level this page cannot name", async () => {
        await openDialog();
        act(() =>
            listener?.({
                ...BASE,
                phase: "done",
                outcome: "installed-home",
                closed: true,
                control: [
                    { rung: "home", state: "got" },
                    { rung: "battery", state: "refused" },
                    { rung: "notification-listener", state: "skipped" },
                    { rung: "from-a-newer-app", state: "got" }
                ]
            })
        );
        expect(await screen.findByText("What this TV allowed")).toBeTruthy();
        expect(screen.getByText("Home screen")).toBeTruthy();
        expect(screen.getByText("Allowed")).toBeTruthy();
        expect(screen.getByText("Refused by this TV")).toBeTruthy();
        expect(screen.getByText("Not tried here")).toBeTruthy();
        expect(screen.queryByText(/from-a-newer-app/)).toBeNull();
    });

    it("says an app-only install changed nothing else", async () => {
        await openDialog();
        act(() =>
            listener?.({ ...BASE, phase: "done", outcome: "installed", closed: true, control: [] })
        );
        expect(
            await screen.findByText("Installed only as an app. Nothing else on the TV was changed.")
        ).toBeTruthy();
        expect(screen.queryByText("What this TV allowed")).toBeNull();
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
        expect(
            await screen.findByRole("button", { name: /Living Room TV - 192\.168\.1\.40/ })
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "192.168.1.51" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    });
});
