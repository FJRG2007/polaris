// @vitest-environment jsdom

/**
 * Adding a connector on Polar's settings page: a button that opens a dialog
 * with the fields, as ChatGPT and Claude do, never a form left open on the page.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolarConnectors } from "@/app/(app)/polar/settings/polar-connectors";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/link", () => ({
    default: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    )
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function draw() {
    return render(<PolarConnectors initial={[]} returned={null} />, { wrapper: MessagesWrapper });
}

describe("adding a connector", () => {
    it("shows no form on the page until the button is pressed", () => {
        draw();
        expect(screen.queryByPlaceholderText("https://mcp.example.com/mcp")).toBeNull();
        expect(screen.queryByRole("dialog")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
        const dialog = screen.getByRole("dialog");
        expect(dialog.textContent).toContain("Add an MCP server");
        expect(screen.getByPlaceholderText("https://mcp.example.com/mcp")).toBeTruthy();
    });

    it("keeps the connection type under Advanced settings", () => {
        draw();
        fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
        expect(screen.queryByText("Connection type")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
        expect(screen.getByText("Connection type")).toBeTruthy();
    });

    it("forgets what was typed once cancelled", () => {
        draw();
        fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
        fireEvent.change(screen.getByPlaceholderText("e.g. Linear"), {
            target: { value: "Linear" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
        expect((screen.getByPlaceholderText("e.g. Linear") as HTMLInputElement).value).toBe("");
    });

    it("says why the server refused inside the dialog, and closes on success", async () => {
        const connector = {
            id: "c1",
            name: "Linear",
            url: "https://mcp.linear.app/mcp",
            auth: "none",
            transport: "http",
            enabled: true,
            signedIn: false,
            status: "ok",
            lastError: null,
            tools: []
        };
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ error: "unreachable" }), { status: 400 })
            )
            .mockResolvedValueOnce(new Response(JSON.stringify({ connector }), { status: 200 }));
        vi.stubGlobal("fetch", fetch);
        draw();
        fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
        fireEvent.change(screen.getByPlaceholderText("e.g. Linear"), {
            target: { value: "Linear" }
        });
        fireEvent.change(screen.getByPlaceholderText("https://mcp.example.com/mcp"), {
            target: { value: "https://mcp.linear.app/mcp" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Add and test" }));
        await waitFor(() =>
            expect(screen.getByRole("dialog").textContent).toContain("The server didn't answer")
        );
        fireEvent.click(screen.getByRole("button", { name: "Add and test" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(screen.getByText("https://mcp.linear.app/mcp")).toBeTruthy();
    });
});
