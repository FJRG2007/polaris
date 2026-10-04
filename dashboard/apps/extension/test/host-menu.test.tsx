// @vitest-environment jsdom
/**
 * Which Polaris this browser is on, from the account menu.
 *
 * Hosts used to be a row on the home screen beside the vault, as if they were an
 * app. They are the menu's now: the one in front ticked, any other one press
 * away, and the screen that adds, renames and removes them under it.
 */

import type { ReactNode } from "react";
import type { Request } from "../src/lib/messages";
import type { VaultStatus } from "../src/lib/messages";
import { TopBar } from "../src/entrypoints/popup/shell";
import { WordsProvider } from "../src/entrypoints/popup/words";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const HOME = "https://home.example.com";
const WORK = "https://work.example.com";
const LONG = "The Polaris in the server cupboard at home";

const STATUS: VaultStatus = {
    server: HOME,
    email: "ada@example.com",
    linked: true,
    linkedAccount: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
    canVault: true,
    connected: true,
    unreachable: false,
    polarisSession: true,
    unlocked: false,
    syncedAt: null,
    timeoutMs: 0,
    accounts: [],
    activeId: "home\nada@example.com",
    awaitingApproval: false,
    organizations: [],
    shelf: null,
    face: null,
    servers: [
        { origin: HOME, name: LONG, host: "home.example.com", active: true, accounts: 1 },
        { origin: WORK, name: null, host: "work.example.com", active: false, accounts: 0 }
    ]
};

let sent: Request[] = [];
let granted = true;

beforeEach(() => {
    sent = [];
    granted = true;
    vi.stubGlobal("browser", {
        permissions: { request: vi.fn(async () => granted) },
        runtime: {
            sendMessage: async (request: Request) => {
                sent.push(request);
                return { ok: true };
            }
        },
        tabs: { create: vi.fn() }
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function inLanguage(locale: "en-US" | "es-ES", children: ReactNode): React.JSX.Element {
    return (
        <WordsProvider initial={locale} follow={() => () => {}}>
            {children}
        </WordsProvider>
    );
}

function openMenu(
    status: VaultStatus = STATUS,
    onOpen: (section: string) => void = () => {},
    locale: "en-US" | "es-ES" = "en-US"
): void {
    render(
        inLanguage(locale, <TopBar status={status} onChange={async () => {}} onOpen={onOpen} />)
    );
    fireEvent.click(screen.getByRole("button", { name: /account menu|menú de la cuenta/ }));
}

describe("the account menu", () => {
    it("lists every host under Host, with the one in front ticked", () => {
        openMenu();
        expect(screen.getByText("Host")).toBeTruthy();
        const rows = screen.getAllByRole("menuitemradio");
        expect(rows.map((row) => row.textContent)).toEqual([LONG, "work.example.com"]);
        expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);
        expect(rows[0]!.querySelector(".menu-check")).not.toBeNull();
        expect(rows[1]!.querySelector(".menu-check")).toBeNull();
    });

    it("cuts a long name to the row and keeps the whole of it in the tooltip", () => {
        openMenu();
        const [named, plain] = screen.getAllByRole("menuitemradio");
        expect(named!.querySelector(".menu-text")?.textContent).toBe(LONG);
        expect(named!.getAttribute("title")).toBe(`${LONG} (home.example.com)`);
        expect(plain!.getAttribute("title")).toBe(WORK);
    });

    it("no longer offers Servers", () => {
        openMenu();
        expect(screen.queryByText("Servers")).toBeNull();
    });

    it("switches to another host, asking the browser for it from the press", async () => {
        openMenu();
        await act(async () => {
            fireEvent.click(screen.getByRole("menuitemradio", { name: "work.example.com" }));
        });
        const request = (
            browser as unknown as { permissions: { request: ReturnType<typeof vi.fn> } }
        ).permissions.request;
        expect(request).toHaveBeenCalledWith({ origins: [`${WORK}/*`] });
        expect(sent).toContainEqual({ kind: "switchServer", origin: WORK });
    });

    it("does nothing for the host already in front", async () => {
        openMenu();
        await act(async () => {
            fireEvent.click(screen.getByRole("menuitemradio", { name: LONG }));
        });
        expect(sent).toEqual([]);
    });

    it("says so, and switches nothing, when the browser refuses the address", async () => {
        granted = false;
        openMenu();
        await act(async () => {
            fireEvent.click(screen.getByRole("menuitemradio", { name: "work.example.com" }));
        });
        expect(sent).toEqual([]);
        expect(document.querySelector(".problem")).not.toBeNull();
    });

    it("opens the hosts screen to add, rename and remove", () => {
        const onOpen = vi.fn();
        openMenu(STATUS, onOpen);
        fireEvent.click(screen.getByRole("menuitem", { name: "Manage hosts" }));
        expect(onOpen).toHaveBeenCalledWith("servers");
    });

    it("keeps Disconnect this browser, as danger words", () => {
        openMenu();
        const disconnect = screen.getByRole("menuitem", { name: "Disconnect this browser" });
        expect(disconnect.className).toBe("menu-item danger");
    });

    it("reads in Spanish", () => {
        openMenu(STATUS, () => {}, "es-ES");
        expect(screen.getByText("Host")).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: "Gestionar hosts" })).toBeTruthy();
    });
});
