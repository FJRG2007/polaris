// @vitest-environment jsdom

/**
 * Renaming a server from the list, and what a right-click on a row offers.
 *
 * F2 acts on the row under the pointer, or on the one last clicked, the way a
 * file manager does - so pointing at a server and pressing it has to open its name
 * for typing, and nothing else. The new name is shown at once and put back if the
 * server refuses it. Delete only ever opens the removal question.
 */

import type { ReactNode } from "react";
import type { ServerRow } from "../../src/app/(app)/apps/servers/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let renames: unknown[] = [];
let renameAnswer: { error?: string } = {};
let removing: { id: string; name: string } | null = null;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("next/link", () => ({
    default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
        <a href={href} {...props}>
            {children}
        </a>
    )
}));
vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({
        data: { servers: [], machineName: "lirio-0" },
        loading: false,
        error: null,
        stale: null,
        refreshing: false,
        updatedAt: null,
        refresh: () => {}
    })
}));
vi.mock("../../src/app/(app)/apps/servers/actions", () => ({
    renameServerAction: async (input: unknown) => {
        renames.push(input);
        return renameAnswer;
    }
}));
vi.mock("../../src/app/(app)/apps/deploy/terminal-panel", () => ({ TerminalPanel: () => null }));
vi.mock("../../src/app/(app)/apps/servers/host-dialog", () => ({ HostDialog: () => null }));
vi.mock("../../src/app/(app)/apps/servers/quick-enroll", () => ({ QuickEnroll: () => null }));
vi.mock("../../src/app/(app)/apps/servers/server-groups", () => ({ ServerGroups: () => null }));
vi.mock("../../src/app/(app)/apps/servers/environment-dialog", () => ({
    EnvironmentDialog: () => null
}));
vi.mock("../../src/app/(app)/apps/servers/remove-server-dialog", () => ({
    RemoveServerDialog: ({ server }: { server: { id: string; name: string } | null }) => {
        removing = server;
        return null;
    }
}));

const { ServersView } = await import("../../src/app/(app)/apps/servers/servers-view");

const HOST_ID = "33333333-3333-4333-8333-333333333333";

function server(overrides: Partial<ServerRow> = {}): ServerRow {
    return {
        id: HOST_ID,
        kind: "host",
        name: "ubuntu",
        detail: "polaris",
        os: "Ubuntu 22.04.2 LTS",
        address: "203.0.113.10",
        port: 22,
        authMethod: "key",
        sudo: true,
        hostId: HOST_ID,
        environment: "vps",
        wildcardDomain: "",
        suggested: "vps",
        confirmed: true,
        ...overrides
    };
}

function rowOf(name: string): HTMLElement {
    const row = screen.getByText(name).closest("tr");
    if (!row) throw new Error(`no row for ${name}`);
    return row;
}

beforeEach(() => {
    renames = [];
    renameAnswer = {};
    removing = null;
    render(<ServersView servers={[server()]} machineName="lirio-0" />);
});

afterEach(cleanup);

describe("renaming a server from the list", () => {
    it("opens the name of the row under the pointer on F2", async () => {
        fireEvent.pointerEnter(rowOf("ubuntu"));
        fireEvent.keyDown(document.body, { key: "F2" });
        const field = await screen.findByRole("textbox", { name: "Server name" });
        expect((field as HTMLInputElement).value).toBe("ubuntu");
    });

    it("acts on the row last clicked when nothing is pointed at", async () => {
        fireEvent.click(rowOf("ubuntu"));
        fireEvent.keyDown(document.body, { key: "F2" });
        expect(await screen.findByRole("textbox", { name: "Server name" })).toBeTruthy();
    });

    it("does nothing with no row pointed at or chosen", () => {
        fireEvent.keyDown(document.body, { key: "F2" });
        expect(screen.queryByRole("textbox", { name: "Server name" })).toBeNull();
    });

    it("saves on Enter and shows the new name straight away", async () => {
        fireEvent.pointerEnter(rowOf("ubuntu"));
        fireEvent.keyDown(document.body, { key: "F2" });
        const field = await screen.findByRole("textbox", { name: "Server name" });
        fireEvent.change(field, { target: { value: "  web-1 " } });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(screen.getByText("web-1")).toBeTruthy();
        await waitFor(() => expect(renames).toEqual([{ hostId: HOST_ID, name: "web-1" }]));
    });

    it("puts the old name back when the server refuses the new one", async () => {
        renameAnswer = { error: "Server not found" };
        fireEvent.pointerEnter(rowOf("ubuntu"));
        fireEvent.keyDown(document.body, { key: "F2" });
        const field = await screen.findByRole("textbox", { name: "Server name" });
        fireEvent.change(field, { target: { value: "web-1" } });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(await screen.findByText("Server not found")).toBeTruthy();
        expect(screen.getByText("ubuntu")).toBeTruthy();
        expect(screen.queryByText("web-1")).toBeNull();
    });

    it("leaves the name alone on Escape", async () => {
        fireEvent.pointerEnter(rowOf("ubuntu"));
        fireEvent.keyDown(document.body, { key: "F2" });
        const field = await screen.findByRole("textbox", { name: "Server name" });
        fireEvent.change(field, { target: { value: "web-1" } });
        fireEvent.keyDown(field, { key: "Escape" });
        expect(screen.getByText("ubuntu")).toBeTruthy();
        expect(renames).toEqual([]);
    });

    it("does not save a registered server with no name", async () => {
        fireEvent.pointerEnter(rowOf("ubuntu"));
        fireEvent.keyDown(document.body, { key: "F2" });
        const field = await screen.findByRole("textbox", { name: "Server name" });
        fireEvent.change(field, { target: { value: "   " } });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(screen.getByText("ubuntu")).toBeTruthy();
        expect(renames).toEqual([]);
    });

    it("keeps Delete typed into the field inside the field", async () => {
        fireEvent.pointerEnter(rowOf("ubuntu"));
        fireEvent.keyDown(document.body, { key: "F2" });
        const field = await screen.findByRole("textbox", { name: "Server name" });
        fireEvent.keyDown(field, { key: "Delete" });
        expect(removing).toBeNull();
    });
});

describe("Delete on a row", () => {
    it("asks before removing the server pointed at", () => {
        fireEvent.pointerEnter(rowOf("ubuntu"));
        fireEvent.keyDown(document.body, { key: "Delete" });
        expect(removing).toEqual({ id: HOST_ID, name: "ubuntu" });
    });
});

describe("a right-click on a row", () => {
    it("offers opening it, a shell, its files, renaming and removing it", async () => {
        fireEvent.contextMenu(rowOf("ubuntu"));
        const menu = await screen.findByRole("menu");
        const text = menu.textContent ?? "";
        for (const item of [
            "Open",
            "Open a shell",
            "Browse its files",
            "Rename",
            "F2",
            "Copy address",
            "Where it lives",
            "Remove"
        ]) {
            expect(text).toContain(item);
        }
    });

    it("opens the name for typing from Rename", async () => {
        fireEvent.contextMenu(rowOf("ubuntu"));
        const rename = await screen.findByRole("menuitem", { name: /Rename/ });
        fireEvent.click(rename);
        expect(await screen.findByRole("textbox", { name: "Server name" })).toBeTruthy();
    });
});
