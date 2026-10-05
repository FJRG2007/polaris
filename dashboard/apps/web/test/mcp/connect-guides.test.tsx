// @vitest-environment jsdom

/**
 * "Connect an MCP client", rendered and clicked through in both languages: the
 * logo grid, search, each client's numbered steps with the exact value to copy
 * in the step that needs it, the labels to look for in bold, and the install
 * link it documents, the generic guide's three connection types, and the guide
 * kept in the address. Every key a guide names must exist
 * in every locale - a missing one would draw as its key.
 */

import { webCatalogs } from "../../messages";
import { MessagesWrapper, withMessages } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_GUIDES, matchClients } from "@/lib/mcp/client-guides";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectGuides } from "@/app/(app)/account/assistants/connect-guides";

const URLS = {
    http: "https://polaris.example.test/api/mcp",
    sse: "https://polaris.example.test/api/mcp/sse"
};

beforeEach(() => window.history.replaceState(null, "", "/account/assistants"));
afterEach(cleanup);

function draw() {
    return render(<ConnectGuides urls={URLS} />, { wrapper: MessagesWrapper });
}

/** Every value on screen that has a copy button. */
function copied(): string[] {
    return [...document.querySelectorAll("code")].map((node) => node.textContent ?? "");
}

describe("the client picker", () => {
    it("shows a tile per client, plus any other client, and no value before one is chosen", () => {
        draw();
        // The URL is shown in the step that pastes it, not above the grid.
        expect(copied()).toEqual([]);
        for (const guide of CLIENT_GUIDES) expect(screen.getByText(guide.name)).toBeTruthy();
        expect(screen.getByText("Any other client")).toBeTruthy();
    });

    it("narrows by name or alias, ignoring case and accents, and says when none match", () => {
        draw();
        const search = screen.getByRole("searchbox", { name: "Search clients" });
        fireEvent.change(search, { target: { value: "MISTRAL" } });
        expect(screen.getByText("Mistral Le Chat")).toBeTruthy();
        expect(screen.queryByText("Cursor")).toBeNull();
        fireEvent.change(search, { target: { value: "nothing-like-it" } });
        expect(screen.getByText(/No client matches "nothing-like-it"/)).toBeTruthy();
        // The generic guide is still offered.
        expect(screen.getByText("Any other client")).toBeTruthy();
        expect(matchClients("cópilot").map((guide) => guide.id)).toContain("copilot");
    });

    it("opens the guide named in the address", () => {
        window.history.replaceState(null, "", "/account/assistants#connect-cursor");
        draw();
        expect(screen.getByRole("region", { name: "Set up Cursor" })).toBeTruthy();
    });
});

describe("a client's guide", () => {
    function open(name: string) {
        draw();
        fireEvent.click(screen.getByText(name));
    }

    /** The labelled values a step shows, as `label: value`. */
    function fields(step: HTMLElement): string[] {
        return [...step.querySelectorAll("code")].map((code) => {
            const label = code.parentElement?.previousElementSibling?.textContent;
            return label ? `${label}: ${code.textContent}` : (code.textContent ?? "");
        });
    }

    it("numbers Claude's steps, with the name and URL to enter and its connectors page", () => {
        open("Claude");
        expect(window.location.hash).toBe("#connect-claude");
        const steps = screen.getAllByRole("listitem");
        expect(steps[0].textContent).toBe(
            "1Open Customize > Connectors and choose Add custom connector."
        );
        expect([...steps[0].querySelectorAll("strong")].map((node) => node.textContent)).toEqual([
            "Customize > Connectors",
            "Add custom connector"
        ]);
        expect(fields(steps[1])).toEqual(["Name: Polaris", `Server URL: ${URLS.http}`]);
        // The URL appears once, where it is pasted.
        expect(copied().filter((value) => value === URLS.http)).toHaveLength(1);
        const link = screen.getByRole("link", { name: /Open Connectors/ });
        expect(link.getAttribute("href")).toBe("https://claude.ai/customize/connectors");
        expect(screen.getAllByRole("listitem").length).toBe(3);
    });

    it("gives ChatGPT every value it asks for in the step that asks, OAuth in bold", () => {
        open("ChatGPT");
        const steps = screen.getAllByRole("listitem");
        expect(steps).toHaveLength(6);
        expect(fields(steps[2])).toEqual(["Name: Polaris", `Server URL: ${URLS.http}`]);
        // Picked from a list, not typed: shown in bold, with nothing to copy.
        expect(fields(steps[3])).toEqual([]);
        expect([...steps[3].querySelectorAll("strong")].map((node) => node.textContent)).toEqual([
            "Authentication",
            "OAuth"
        ]);
        expect([...steps[0].querySelectorAll("strong")].map((node) => node.textContent)).toEqual([
            "Settings > Security and login",
            "Developer mode"
        ]);
        expect(screen.queryByRole("button", { name: /Copy authentication/i })).toBeNull();
    });

    it("never prints a tag as text, in any guide or locale", () => {
        for (const locale of ["en-US", "es-ES"] as const)
            for (const guide of CLIENT_GUIDES) {
                window.history.replaceState(null, "", `/account/assistants#connect-${guide.id}`);
                const { container, unmount } = render(
                    withMessages(<ConnectGuides urls={URLS} />, locale)
                );
                expect(container.textContent, `${locale} ${guide.id}`).not.toMatch(/<\/?b>/);
                expect(screen.getByRole("region", { name: /./ })).toBeTruthy();
                unmount();
            }
    });

    it("gives Cursor its documented install link and mcp.json entry", () => {
        open("Cursor");
        const install = screen.getByRole("link", { name: "Add to Cursor" });
        const href = install.getAttribute("href")!;
        expect(
            href.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=polaris&config=")
        ).toBe(true);
        const config = new URL(href).searchParams.get("config")!;
        expect(JSON.parse(atob(config))).toEqual({ url: URLS.http });
        expect(copied()).toContain(
            JSON.stringify({ mcpServers: { polaris: { url: URLS.http } } }, null, 2)
        );
    });

    it("gives VS Code its install link", () => {
        open("Visual Studio Code");
        const href = screen.getByRole("link", { name: "Add to VS Code" }).getAttribute("href")!;
        expect(JSON.parse(decodeURIComponent(href.slice("vscode:mcp/install?".length)))).toEqual({
            name: "polaris",
            type: "http",
            url: URLS.http
        });
    });

    it("gives the terminal clients their exact commands", () => {
        open("Kimi Code");
        expect(copied()).toEqual(
            expect.arrayContaining([
                `kimi mcp add --transport http --auth oauth polaris ${URLS.http}`,
                "kimi mcp auth polaris"
            ])
        );
        fireEvent.click(screen.getByRole("button", { name: "All clients" }));
        fireEvent.click(screen.getByText("OpenCode"));
        expect(copied()).toContain("opencode mcp auth polaris");
        fireEvent.click(screen.getByRole("button", { name: "All clients" }));
        fireEvent.click(screen.getByText("GitHub Copilot"));
        expect(copied()).toContain(`copilot mcp add --transport http polaris ${URLS.http}`);
    });

    it("links each client's own documentation", () => {
        open("Zapier");
        const docs = screen.getByRole("link", { name: /Official setup guide/ });
        expect(docs.getAttribute("href")).toContain("help.zapier.com");
        expect(docs.getAttribute("target")).toBe("_blank");
    });

    it("goes back to the grid", () => {
        open("Devin");
        const back = screen.getByRole("button", { name: "All clients" });
        // The tile that opened the guide is gone; focus lands on the way back.
        expect(document.activeElement).toBe(back);
        fireEvent.click(back);
        expect(document.activeElement).toBe(screen.getByRole("searchbox"));
        expect(window.location.hash).toBe("#connect");
    });
});

describe("any other client", () => {
    it("offers the three connection types with the exact configuration for each", () => {
        draw();
        fireEvent.click(screen.getByText("Any other client"));
        expect(screen.getAllByRole("listitem").length).toBe(4);
        expect(copied()).toContain(
            JSON.stringify({ mcpServers: { polaris: { url: URLS.http } } }, null, 2)
        );

        fireEvent.click(screen.getByRole("radio", { name: "SSE" }));
        expect(copied()).toContain(
            JSON.stringify({ mcpServers: { polaris: { type: "sse", url: URLS.sse } } }, null, 2)
        );

        fireEvent.click(screen.getByRole("radio", { name: "stdio" }));
        expect(copied()).toContain(
            JSON.stringify(
                {
                    mcpServers: {
                        polaris: { command: "npx", args: ["-y", "mcp-remote", URLS.http] }
                    }
                },
                null,
                2
            )
        );
        expect(screen.getByRole("link", { name: "Create a key" }).getAttribute("href")).toBe(
            "/account/api-keys/new"
        );
    });
});

describe("in Spanish", () => {
    it("reads in Spanish", () => {
        render(withMessages(<ConnectGuides urls={URLS} />, "es-ES"));
        expect(screen.getByText("Conectar un cliente MCP")).toBeTruthy();
        fireEvent.click(screen.getByText("Otro cliente"));
        expect(screen.getByText("Elige un tipo de conexión.")).toBeTruthy();
    });

    it("has every key a guide names, in every locale", () => {
        for (const locale of ["en-US", "es-ES"] as const) {
            const catalog = webCatalogs.pick(locale, ["mcpConnect"]).mcpConnect as {
                clients: Record<string, Record<string, string>>;
            };
            for (const guide of CLIENT_GUIDES) {
                const keys = [
                    ...guide.steps.map((step) => step.key),
                    ...(guide.notes ?? []),
                    ...(guide.install ? [guide.install.key] : []),
                    ...(guide.open ? [guide.open.key] : [])
                ];
                for (const key of keys)
                    expect(
                        catalog.clients[guide.id]?.[key],
                        `${locale} ${guide.id}.${key}`
                    ).toBeTypeOf("string");
            }
        }
    });
});
