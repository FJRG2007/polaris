// @vitest-environment jsdom
/**
 * Polar's settings as a page: web search on for somebody who never chose,
 * the tools grouped by the MCP server they come from - Polaris built in, each
 * connector its own - with a switch per server and per tool, the gear in the
 * chat going to the page instead of opening a dialog, and the old address
 * landing on it.
 */

import { resolve } from "node:path";
import config from "../../next.config.mjs";
import { MessagesWrapper } from "../setup/i18n";
import { existsSync, readFileSync } from "node:fs";
import { SettingsBack } from "@/app/(app)/polar/settings/settings-back";
import { SETTINGS_FROM_CHAT_KEY } from "@/lib/polar/settings-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupToolsByServer, offWithServers } from "@/lib/polar/tool-servers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const kept = new Map<string, string>();
const pushed: string[] = [];
let answer: Record<string, unknown> = {};
let wentBack = false;

vi.mock("@ai-sdk/react", () => ({
    useChat: () => ({
        status: "ready",
        messages: [],
        error: undefined,
        sendMessage: async () => undefined,
        stop: async () => undefined,
        setMessages: () => undefined,
        regenerate: async () => undefined,
        addToolApprovalResponse: async () => undefined
    })
}));
vi.mock("next/navigation", () => ({
    usePathname: () => "/tasks",
    useRouter: () => ({
        push: (href: string) => void pushed.push(href),
        back: () => void (wentBack = true)
    })
}));

const TOOLS = {
    read_tasks: { title: "Read tasks", writes: false, destructive: false },
    delete_task: { title: "Delete a task", writes: true, destructive: true },
    mcp_linear__issues: {
        title: "Linear: List issues",
        writes: false,
        destructive: false,
        connector: "Linear"
    }
};

beforeEach(() => {
    kept.clear();
    pushed.length = 0;
    wentBack = false;
    answer = { providers: [], tools: TOOLS, isAdmin: false, web: true, connectors: true };
    const storage = {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
        clear: () => kept.clear()
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", { ...storage, getItem: () => null });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            return url === "/api/polar/models" ? Response.json(answer) : Response.json({});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const { PolarToolSettings } = await import("@/components/polar/polar-settings");
const { PolarChat } = await import("@/components/polar/polar-panel");

const page = () => render(<PolarToolSettings />, { wrapper: MessagesWrapper });

describe("web search", () => {
    it("is on for somebody who never chose", async () => {
        page();
        const toggle = await screen.findByRole("switch", { name: "Search the web" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect((toggle as HTMLButtonElement).disabled).toBe(false);
    });

    it("stays on when the server's answer does not say, or does not come", async () => {
        answer = { providers: [], tools: TOOLS };
        page();
        const toggle = await screen.findByRole("switch", { name: "Search the web" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        cleanup();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({}, { status: 500 }))
        );
        page();
        const again = await screen.findByRole("switch", { name: "Search the web" });
        expect(again.getAttribute("aria-checked")).toBe("true");
    });
});

describe("tools by MCP server", () => {
    it("groups Polaris first, then each connector, without the connector's prefix", () => {
        const groups = groupToolsByServer(TOOLS);
        expect(groups.map((group) => group.id)).toEqual(["polaris", "connector:Linear"]);
        expect(groups[0]!.tools.map((tool) => tool.title)).toEqual(["Delete a task", "Read tasks"]);
        expect(groups[1]!.tools.map((tool) => tool.title)).toEqual(["List issues"]);
    });

    it("shows each server with its switch and a count, and its tools behind a disclosure", async () => {
        kept.set("polar.toolsOff", JSON.stringify(["delete_task"]));
        page();
        const polaris = await screen.findByRole("button", { name: /Polaris/ });
        expect(polaris.textContent).toContain("Built in");
        expect(polaris.textContent).toContain("1 of 2 on");
        expect(polaris.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByRole("switch", { name: "Read tasks" })).toBeNull();
        expect(screen.getByRole("switch", { name: "Use Polaris" })).toBeTruthy();
        const linear = screen.getByRole("button", { name: /Linear/ });
        expect(linear.textContent).toContain("1 of 1 on");
        expect(screen.getByRole("switch", { name: "Use Linear" })).toBeTruthy();
        fireEvent.click(polaris);
        expect(polaris.getAttribute("aria-expanded")).toBe("true");
        const list = document.getElementById(polaris.getAttribute("aria-controls")!)!;
        expect(within(list).getByRole("switch", { name: "Read tasks" })).toBeTruthy();
        expect(
            within(list).getByRole("switch", { name: "Delete a task" }).getAttribute("aria-checked")
        ).toBe("false");
    });

    it("switches a whole server off without losing the choices inside it", async () => {
        kept.set("polar.toolsOff", JSON.stringify(["delete_task"]));
        page();
        fireEvent.click(await screen.findByRole("switch", { name: "Use Polaris" }));
        expect(JSON.parse(kept.get("polar.serversOff")!)).toEqual(["polaris"]);
        expect(JSON.parse(kept.get("polar.toolsOff")!)).toEqual(["delete_task"]);
        const polaris = screen.getByRole("button", { name: /Polaris/ });
        expect(polaris.textContent).toContain("Switched off");
        fireEvent.click(polaris);
        const read = screen.getByRole("switch", { name: "Read tasks" });
        expect((read as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole("switch", { name: "Use Polaris" }));
        expect(JSON.parse(kept.get("polar.serversOff")!)).toEqual([]);
        expect(polaris.textContent).toContain("1 of 2 on");
    });

    it("takes every tool of a server that is off out of what a turn may offer", () => {
        const off = offWithServers([], ["connector:Linear"], TOOLS);
        expect([...off]).toEqual(["mcp_linear__issues"]);
        expect([...offWithServers(["read_tasks"], ["polaris"], TOOLS)].sort()).toEqual([
            "delete_task",
            "read_tasks"
        ]);
    });

    it("keeps the old all-connectors switch off for each connector", async () => {
        kept.set("polar.connectors", "off");
        page();
        expect((await screen.findByRole("button", { name: /Linear/ })).textContent).toContain(
            "Switched off"
        );
        fireEvent.click(screen.getByRole("switch", { name: "Use Linear" }));
        expect(kept.has("polar.connectors")).toBe(false);
        expect(JSON.parse(kept.get("polar.serversOff")!)).toEqual([]);
    });

    it("keeps the list it last saw when the server's answer fails", async () => {
        const cached = { tools: TOOLS, web: true, connectors: true };
        const session = new Map([["polar.settingsTools", JSON.stringify(cached)]]);
        vi.stubGlobal("sessionStorage", {
            getItem: (key: string) => session.get(key) ?? null,
            setItem: (key: string, value: string) => void session.set(key, value),
            removeItem: (key: string) => void session.delete(key)
        });
        const failing = vi.fn(async () => Response.json({}, { status: 500 }));
        vi.stubGlobal("fetch", failing);
        page();
        expect(await screen.findByRole("button", { name: /Linear/ })).toBeTruthy();
        await vi.waitFor(() => expect(failing).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.getByRole("button", { name: /Linear/ })).toBeTruthy();
        expect(JSON.parse(session.get("polar.settingsTools")!)).toEqual(cached);
    });

    it("hides the connectors where the deployment does not allow them", async () => {
        answer = { ...answer, connectors: false };
        page();
        await screen.findByRole("button", { name: /Polaris/ });
        expect(screen.queryByRole("button", { name: /Linear/ })).toBeNull();
    });
});

describe("the settings page", () => {
    it("is where the gear in the chat goes, with no dialog", async () => {
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await screen.findByRole("textbox");
        fireEvent.click(screen.getByRole("button", { name: "Polar settings" }));
        expect(pushed).toEqual(["/polar/settings"]);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("goes back to the chat that opened it, and to Polar's page otherwise", () => {
        const session = new Map<string, string>([[SETTINGS_FROM_CHAT_KEY, "1"]]);
        vi.stubGlobal("sessionStorage", {
            getItem: (key: string) => session.get(key) ?? null,
            setItem: (key: string, value: string) => void session.set(key, value),
            removeItem: (key: string) => void session.delete(key)
        });
        window.history.pushState({}, "", "/polar/settings");
        render(<SettingsBack label="Back to chat" />);
        expect(session.has(SETTINGS_FROM_CHAT_KEY)).toBe(false);
        fireEvent.click(screen.getByRole("link", { name: "Back to chat" }));
        expect(wentBack).toBe(true);
        cleanup();
        wentBack = false;
        render(<SettingsBack label="Back to chat" />);
        const link = screen.getByRole("link", { name: "Back to chat" });
        expect(link.getAttribute("href")).toBe("/polar");
        fireEvent.click(link);
        expect(wentBack).toBe(false);
    });

    it("is a route, and the settings component holds no dialog", () => {
        const root = resolve(__dirname, "../../src");
        expect(existsSync(resolve(root, "app/(app)/polar/settings/page.tsx"))).toBe(true);
        const source = readFileSync(resolve(root, "components/polar/polar-settings.tsx"), "utf8");
        expect(source).not.toMatch(/DialogContent|PolarSettings\(/);
    });

    it("takes over /account/polar-tools, sign-in answer included", async () => {
        // A 307 before anything is drawn; the query is carried across by Next.
        const rules = (await config.redirects()).filter(
            (rule) => rule.source === "/account/polar-tools"
        );
        expect(rules).toEqual([
            {
                source: "/account/polar-tools",
                has: [{ type: "query", key: "connector", value: "(?:signed_in|failed)" }],
                destination: "/polar/settings#connectors",
                permanent: false
            },
            {
                source: "/account/polar-tools",
                destination: "/polar/settings#permissions",
                permanent: false
            }
        ]);
        // Next anchors the value as `^value$`.
        const answer = new RegExp(`^${rules[0]?.has?.[0]?.value}$`);
        expect(answer.test("signed_in") && answer.test("failed")).toBe(true);
        expect(["<script>", "signed_in_x", "x_failed"].some((v) => answer.test(v))).toBe(false);
        const page = resolve(__dirname, "../../src/app/(app)/account/polar-tools/page.tsx");
        expect(existsSync(page)).toBe(false);
    });
});
