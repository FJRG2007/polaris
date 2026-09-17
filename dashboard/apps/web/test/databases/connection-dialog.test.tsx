// @vitest-environment jsdom

/**
 * The form that connects a database.
 *
 * Three things are asserted because all three were reported: the engine is
 * picked the way a service is picked in Apps, with the project's own mark;
 * read-only is not ticked for somebody who never asked for it; and a database
 * that is not published on the network can be reached over SSH from here.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const saved: unknown[] = [];

vi.mock("@/app/(app)/apps/databases/actions", () => ({
    engineOptionsAction: async () => ({
        engines: [
            { id: "postgres", label: "PostgreSQL", port: 5432 },
            { id: "mysql", label: "MySQL", port: 3306 }
        ]
    }),
    listManagedAction: async () => ({ databases: [] }),
    listTunnelServersAction: async () => ({
        servers: [{ id: "22222222-2222-4222-8222-222222222222", name: "lirio-0", address: "10.0.0.2" }]
    }),
    saveConnectionAction: async (input: unknown) => {
        saved.push(input);
        return { id: "new" };
    }
}));

const { ConnectionDialog } = await import("@/app/(app)/apps/databases/connection-dialog");

// What jsdom does not implement and Radix's menus call on the way open.
beforeAll(() => {
    Object.assign(Element.prototype, {
        hasPointerCapture: () => false,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
        scrollIntoView: () => undefined
    });
});

afterEach(() => {
    cleanup();
    saved.length = 0;
});

function open() {
    return render(<ConnectionDialog connection={null} onClose={() => undefined} onSaved={() => undefined} />);
}

/** A saved connection reached over SSH, as the list hands one to the form. */
function tunnelled(tunnel: Record<string, unknown>) {
    return render(
        <ConnectionDialog
            connection={
                {
                    id: "11111111-1111-4111-8111-111111111111",
                    name: "Production",
                    engine: "postgres",
                    origin: "saved",
                    managedDatabaseId: null,
                    where: "127.0.0.1:5432",
                    database: null,
                    username: "app",
                    readOnly: false,
                    tls: false,
                    host: "127.0.0.1",
                    port: 5432,
                    tunnel,
                    note: null,
                    unreachable: false,
                    lastUsedAt: null,
                    createdAt: null
                } as never
            }
            onClose={() => undefined}
            onSaved={() => undefined}
        />
    );
}

const MANUAL_TUNNEL = {
    mode: "manual",
    host: "ssh.example.com",
    port: 2222,
    username: "root",
    authMethod: "password",
    jumpHostId: null,
    jumpHostName: null,
    jumpMissing: false
};

describe("the connection form", () => {
    it("picks the engine with its own mark, not a list of words", async () => {
        open();
        const trigger = screen.getByRole("combobox", { name: "Engine" });
        // The mark of what is chosen is mirrored in the closed trigger.
        expect(trigger.querySelector("svg")).toBeTruthy();

        await userEvent.click(trigger);
        const option = await screen.findByRole("option", { name: /PostgreSQL/ });
        expect(option.querySelector("svg")).toBeTruthy();
    });

    it("leaves read-only off until somebody turns it on", () => {
        open();
        expect(screen.getByRole("switch", { name: "Read-only" }).getAttribute("aria-checked")).toBe("false");
    });

    it("offers the SSH tunnel, with the servers Polaris already has", async () => {
        open();
        await userEvent.click(screen.getByRole("switch", { name: "Reach it over SSH" }));
        expect(await screen.findByRole("combobox", { name: "Server to tunnel through" })).toBeTruthy();

        await userEvent.click(screen.getByRole("radio", { name: "Another login" }));
        expect(screen.getByPlaceholderText("ssh.example.com")).toBeTruthy();
        expect(screen.getByPlaceholderText("root")).toBeTruthy();
        expect(screen.getByRole("radio", { name: "Private key" })).toBeTruthy();
        expect(screen.getByRole("combobox", { name: "Server to jump through" })).toBeTruthy();
    });

    it("says what is wrong with an address as it is typed, and refuses to save it", async () => {
        open();
        await userEvent.type(screen.getByLabelText("Name"), "Production");
        await userEvent.type(screen.getByLabelText("Host"), "postgres://db.example.com/app");

        expect(await screen.findByText(/without the rest of a URL/)).toBeTruthy();
        expect(screen.getByRole("button", { name: /Add it/ }).hasAttribute("disabled")).toBe(true);
    });

    it("says the server has to be picked rather than disabling Save in silence", async () => {
        open();
        await userEvent.type(screen.getByLabelText("Name"), "Production");
        await userEvent.type(screen.getByLabelText("Host"), "127.0.0.1");
        await userEvent.click(screen.getByRole("switch", { name: "Reach it over SSH" }));

        expect(await screen.findByText("Pick the server to tunnel through.")).toBeTruthy();
        expect(screen.getByRole("button", { name: /Add it/ }).hasAttribute("disabled")).toBe(true);

        await userEvent.click(screen.getByRole("combobox", { name: "Server to tunnel through" }));
        await userEvent.click(await screen.findByRole("option", { name: /lirio-0/ }));

        expect(screen.getByRole("button", { name: /Add it/ }).hasAttribute("disabled")).toBe(false);
    });

    it("asks for the secret again when the SSH login switches to a key", async () => {
        tunnelled(MANUAL_TUNNEL);
        const save = screen.getByRole("button", { name: /Save/ });
        expect(save.hasAttribute("disabled")).toBe(false);

        await userEvent.click(screen.getByRole("radio", { name: "Private key" }));

        expect(save.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText(/Needed to sign in/)).toBeTruthy();
    });

    it("makes the reader answer the jump picker when that bastion was removed", async () => {
        tunnelled({ ...MANUAL_TUNNEL, jumpMissing: true });
        const save = screen.getByRole("button", { name: /Save/ });
        expect(save.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText(/was removed from Servers/)).toBeTruthy();

        await userEvent.click(screen.getByRole("combobox", { name: "Server to jump through" }));
        await userEvent.click(await screen.findByRole("option", { name: "Straight to it" }));

        expect(save.hasAttribute("disabled")).toBe(false);
    });

    it("says which server was removed rather than leaving an empty picker", async () => {
        tunnelled({ mode: "server", hostId: null, hostName: null });

        expect(await screen.findByText(/was removed from Servers/)).toBeTruthy();
        expect(screen.getByRole("button", { name: /Save/ }).hasAttribute("disabled")).toBe(true);
    });

    it("sends what was filled in, read-only off", async () => {
        open();
        await userEvent.type(screen.getByLabelText("Name"), "Production");
        await userEvent.type(screen.getByLabelText("Host"), "db.example.com");
        await userEvent.click(screen.getByRole("button", { name: /Add it/ }));

        expect(saved[0]).toMatchObject({
            name: "Production",
            engine: "postgres",
            host: "db.example.com",
            readOnly: false,
            ssh: null
        });
    });
});
