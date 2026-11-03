// @vitest-environment jsdom
/**
 * Adding a host from the hosts screen: an address already on the list says so
 * as it is typed, naming the row it is, and a name typed beside a new address
 * goes to the worker with it.
 */

import { WordsProvider } from "../src/entrypoints/popup/words";
import type { Request, VaultStatus } from "../src/lib/messages";
import { ServersPanel } from "../src/entrypoints/popup/servers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const HOME = "https://home.example.com";
const WORK = "https://work.example.com";

const STATUS: VaultStatus = {
    server: HOME,
    email: "ada@example.com",
    linked: true,
    linkedAccount: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
    canVault: true,
    canPolar: true,
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
        { origin: HOME, name: null, host: "home.example.com", active: true, accounts: 1 },
        { origin: WORK, name: "Work", host: "work.example.com", active: false, accounts: 0 }
    ]
};

let sent: Request[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(JSON.stringify({ product: "polaris", protocol: 1 }), {
                    headers: { "content-type": "application/json" }
                })
        )
    );
    vi.stubGlobal("browser", {
        permissions: { request: vi.fn(async () => true) },
        runtime: {
            sendMessage: async (request: Request) => {
                sent.push(request);
                return { ok: true };
            }
        }
    });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function openAdd(locale: "en-US" | "es-ES" = "en-US"): void {
    render(
        <WordsProvider initial={locale} follow={() => () => {}}>
            <ServersPanel status={STATUS} onChange={async () => {}} />
        </WordsProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: /Add a host|Añadir host/ }));
}

const address = () => screen.getByPlaceholderText("polaris.example.com");
const addButton = () => screen.getByRole("button", { name: /^(Add|Añadir)$/ });

describe("adding a host", () => {
    it("says at once that an address is already listed, by the row's name", () => {
        openAdd();
        fireEvent.change(address(), { target: { value: "work.example.com/" } });
        expect(screen.getByText("Already on your list as Work.")).toBeTruthy();
        expect(addButton().getAttribute("aria-disabled")).toBe("true");
    });

    it("names an unnamed row by its host, and reads in Spanish", () => {
        openAdd("es-ES");
        fireEvent.change(address(), { target: { value: "https://home.example.com" } });
        expect(screen.getByText("Ya está en tu lista como home.example.com.")).toBeTruthy();
    });

    it("sends the name typed with a new address, tidied", async () => {
        openAdd();
        fireEvent.change(address(), { target: { value: "lab.example.com" } });
        fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
            target: { value: "  Home   lab " }
        });
        await act(() => vi.advanceTimersByTimeAsync(1_000));
        expect(addButton().getAttribute("aria-disabled")).toBe("false");
        await act(async () => {
            fireEvent.click(addButton());
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(sent).toContainEqual({
            kind: "addServer",
            typed: "lab.example.com",
            name: "Home lab"
        });
    });

    it("keeps Add off while the name is too long", async () => {
        openAdd();
        fireEvent.change(address(), { target: { value: "long.example.com" } });
        fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
            target: { value: "x".repeat(41) }
        });
        await act(() => vi.advanceTimersByTimeAsync(1_000));
        expect(screen.getByText("A name can be up to 40 characters.")).toBeTruthy();
        expect(addButton().getAttribute("aria-disabled")).toBe("true");
    });
});
