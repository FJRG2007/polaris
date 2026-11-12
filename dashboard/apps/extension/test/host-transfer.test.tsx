// @vitest-environment jsdom
/**
 * Moving hosts from the hosts screen: the section opens on its six actions, the
 * QR is drawn from the list, a pasted code is checked as it is typed with Add
 * off until it reads as a list, and what the worker did is said in one line.
 */

import { encodeHostList } from "@polaris/core";
import type { ServerRef } from "../src/lib/servers";
import type { Reply, Request } from "../src/lib/messages";
import { WordsProvider } from "../src/entrypoints/popup/words";
import { HostTransfer } from "../src/entrypoints/popup/host-transfer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const SERVERS: ServerRef[] = [
    { origin: "https://home.example.com", name: "Home", host: "home.example.com", active: true, accounts: 1 },
    { origin: "https://work.example.com", name: null, host: "work.example.com", active: false, accounts: 0 }
];

let sent: Request[] = [];
let reply: Reply = { ok: true, imported: { added: 2, named: 1, skipped: 0 } };
const created: string[] = [];

beforeEach(() => {
    sent = [];
    created.length = 0;
    vi.stubGlobal("browser", {
        runtime: {
            getURL: (path: string) => `chrome-extension://polaris${path}`,
            sendMessage: async (request: Request) => {
                sent.push(request);
                return reply;
            }
        },
        tabs: { create: async ({ url }: { url: string }) => void created.push(url) }
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function draw(servers: readonly ServerRef[] = SERVERS, locale: "en-US" | "es-ES" = "en-US") {
    const onChange = vi.fn(async () => {});
    render(
        <WordsProvider initial={locale} follow={() => () => {}}>
            <HostTransfer servers={servers} onChange={onChange} />
        </WordsProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: /^(Show|Ver)$/ }));
    return onChange;
}

const button = (name: string) => screen.getByRole("button", { name });

describe("moving hosts", () => {
    it("opens on every way to move the list", () => {
        draw();
        expect(screen.getByText("Move your hosts")).toBeTruthy();
        for (const name of [
            "Show QR",
            "Scan QR",
            "Copy as code",
            "Paste a code",
            "Export to file",
            "Import from file"
        ]) {
            expect(button(name)).toBeTruthy();
        }
    });

    it("reads in Spanish", () => {
        draw(SERVERS, "es-ES");
        expect(screen.getByText("Mover tus hosts")).toBeTruthy();
        expect(button("Pegar código")).toBeTruthy();
    });

    it("draws the list as a QR", () => {
        draw();
        fireEvent.click(button("Show QR"));
        const qr = screen.getByRole("img", { name: "QR code of your 2 hosts" });
        expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d/);
    });

    it("keeps the outgoing actions off while there is nothing to move", () => {
        draw([]);
        expect(button("Show QR").getAttribute("aria-disabled")).toBe("true");
        expect(button("Export to file").getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(button("Show QR"));
        expect(screen.queryByRole("img")).toBeNull();
    });

    it("opens the scan in a tab of its own", () => {
        draw();
        fireEvent.click(button("Scan QR"));
        expect(created).toEqual(["chrome-extension://polaris/scan.html"]);
    });

    it("keeps Add off until the pasted text is a list, and says what it did", async () => {
        const onChange = draw();
        fireEvent.click(button("Paste a code"));
        const add = button("Add hosts");
        expect(add.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(add);
        expect(sent).toEqual([]);

        const field = screen.getByRole("textbox", { name: "Code from the other device" });
        fireEvent.change(field, { target: { value: "not a code" } });
        expect(screen.getByText("That is not a list of Polaris hosts.")).toBeTruthy();
        expect(add.getAttribute("aria-disabled")).toBe("true");

        const code = encodeHostList([{ origin: "https://lab.example.com", name: "Lab" }]);
        fireEvent.change(field, { target: { value: code } });
        expect(add.getAttribute("aria-disabled")).toBe("false");
        await act(async () => {
            fireEvent.click(add);
        });
        expect(sent).toEqual([{ kind: "importHosts", text: code }]);
        expect(screen.getByText("2 hosts added, 1 host named.")).toBeTruthy();
        expect(onChange).toHaveBeenCalled();
    });

    it("shows the worker's refusal and leaves the list alone", async () => {
        reply = { ok: false, error: "That is not a list of Polaris hosts." };
        const onChange = draw();
        fireEvent.click(button("Paste a code"));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: encodeHostList([]) } });
        await act(async () => {
            fireEvent.click(button("Add hosts"));
        });
        expect(screen.getByRole("status").textContent).toBe("That is not a list of Polaris hosts.");
        expect(onChange).not.toHaveBeenCalled();
        reply = { ok: true, imported: { added: 2, named: 1, skipped: 0 } };
    });
});
