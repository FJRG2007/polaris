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
        // The form gives way to the new connector's detail, marked custom.
        await waitFor(() =>
            expect(screen.queryByPlaceholderText("https://mcp.example.com/mcp")).toBeNull()
        );
        const detail = screen.getByRole("dialog");
        expect(detail.textContent).toContain("Linear");
        expect(detail.textContent).toContain("Custom");
        expect(screen.getByText("https://mcp.linear.app/mcp")).toBeTruthy();
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe("the directory", () => {
    const row = (name: string, url = `https://${name}.example/mcp`, extra = {}) => ({
        id: name,
        name,
        url,
        auth: "none" as const,
        transport: "http" as const,
        enabled: true,
        signedIn: false,
        status: "ok",
        lastError: null,
        checkedAt: null,
        tools: [],
        ...extra
    });
    const seven = ["one", "two", "three", "four", "five", "six", "seven"].map((name) => row(name));
    const list = (rows: unknown[] = seven) =>
        render(<PolarConnectors initial={rows as never} returned={null} />, {
            wrapper: MessagesWrapper
        });
    /** The server answers a page holding only these directory entries. */
    const serverPage = (items: unknown[] = []) => {
        const fetch = vi.fn(async () =>
            Response.json({
                items,
                next: null,
                total: items.length,
                counts: { all: 0, connected: 0, attention: 0 }
            })
        );
        vi.stubGlobal("fetch", fetch);
        return fetch;
    };
    const search = () => screen.getByRole("textbox", { name: "Search connectors" });

    it("lists a connected catalog server once, with its state, and never as a second list", () => {
        list([row("Stripe", "https://mcp.stripe.com")]);
        expect(screen.getAllByText("Stripe", { exact: true })).toHaveLength(1);
        expect(screen.queryByText(/marketplace/i)).toBeNull();
        expect(screen.getByRole("button", { name: "Connect Binance" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Connect Stripe" })).toBeNull();
        expect(screen.getByRole("radio", { name: "Connected (1)" })).toBeTruthy();
    });

    it("narrows at once while it asks the server for the search", async () => {
        const fetch = serverPage([]);
        list();
        fireEvent.change(search(), { target: { value: "one" } });
        expect(screen.getByText("one")).toBeTruthy();
        expect(screen.queryByText("two")).toBeNull();
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining("/api/polar/connectors/directory?q=one"),
                expect.anything()
            )
        );
    });

    it("says so when nothing matches, and offers to add the server by its address", async () => {
        serverPage([]);
        list();
        fireEvent.change(search(), { target: { value: "nothing" } });
        expect(await screen.findByText("No connector matches.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Add by address" }));
        expect(screen.getByRole("dialog").textContent).toContain("Add an MCP server");
    });

    it("says when the list could not be read, with a way to try again", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
        list();
        fireEvent.change(search(), { target: { value: "zzz" } });
        expect(await screen.findByText("Couldn't load the connectors.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    });

    it("opens a connector's detail with its tools, and disconnects from there", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
        list([
            row("one", undefined, {
                tools: [
                    {
                        name: "create_issue",
                        title: "Create issue",
                        description: "Opens an issue.",
                        readOnly: false,
                        destructive: false,
                        policy: "ask"
                    }
                ]
            }),
            row("two")
        ]);
        fireEvent.click(screen.getByRole("button", { name: /^one/ }));
        const detail = screen.getByRole("dialog");
        expect(detail.textContent).toContain("Create issue");
        expect(screen.getByRole("radiogroup", { name: "What Polar may do with Create issue" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Remove one" }));
        fireEvent.change(await screen.findByRole("textbox"), { target: { value: "one" } });
        fireEvent.click(screen.getByRole("button", { name: /^(Delete|Remove)/ }));
        await waitFor(() => expect(screen.queryByText("one")).toBeNull());
        expect(screen.getByText("two")).toBeTruthy();
    });
});
