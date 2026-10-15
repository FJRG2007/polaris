// @vitest-environment jsdom

/**
 * The SSH keys tab: the key Polaris signs in with cannot be removed from here,
 * any other key is removed only after a question in the page's own dialog, and
 * a pasted key is checked as it is typed against the same schema the server uses.
 */

import type { ReactNode } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const HOST = "6f1c1f5e-5b7a-4c3e-9a51-0a2b3c4d5e6f";
let removed: unknown[] = [];

vi.mock("next/link", () => ({
    default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>
}));
vi.mock("../../src/app/(app)/apps/servers/ssh-key-actions", () => ({
    serverKeysAction: async () => ({
        view: {
            logins: [{ name: "polaris", self: true }],
            root: false,
            login: "polaris",
            keys: [
                { type: "ssh-ed25519", comment: "polaris@host", fingerprint: "SHA256:own", options: "", polaris: true },
                { type: "ssh-ed25519", comment: "laptop", fingerprint: "SHA256:other", options: "", polaris: false }
            ]
        }
    }),
    removeServerKeyAction: async (input: unknown) => {
        removed.push(input);
        return {};
    },
    addServerKeysAction: async () => ({ added: 1 }),
    generateServerKeyAction: async () => ({}),
    githubKeysAction: async () => ({ linked: false, accounts: [] })
}));

const { ServerSshKeys } = await import("../../src/app/(app)/apps/servers/server-ssh-keys");

beforeEach(() => {
    removed = [];
});
afterEach(cleanup);

describe("server SSH keys tab", () => {
    it("protects Polaris's key and asks before removing another", async () => {
        render(<ServerSshKeys hostId={HOST} />, { wrapper: MessagesWrapper });
        await screen.findByText("laptop");
        const buttons = screen.getAllByRole("button", { name: "Remove key" });
        expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
        expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
        expect(screen.getByText("Only Polaris's own login is listed", { exact: false })).toBeTruthy();

        fireEvent.click(buttons[1]!);
        const dialog = await screen.findByRole("dialog");
        expect(removed).toEqual([]);
        fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));
        await waitFor(() => expect(removed).toEqual([{ hostId: HOST, login: "polaris", fingerprint: "SHA256:other" }]));
    });

    it("checks a pasted key as it is typed", async () => {
        render(<ServerSshKeys hostId={HOST} />, { wrapper: MessagesWrapper });
        await screen.findByText("laptop");
        fireEvent.click(screen.getByRole("button", { name: "Add key" }));
        const dialog = await screen.findByRole("dialog");
        const add = within(dialog).getByRole("button", { name: "Add key" });
        expect((add as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "not a key" } });
        expect((add as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(within(dialog).getByRole("textbox"), {
            target: { value: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC6nfRyrF9ZLkhQiv1Ro3kMlqLi+nRMTsd23qHItoXrp you@laptop" }
        });
        expect((add as HTMLButtonElement).disabled).toBe(false);
    });
});
