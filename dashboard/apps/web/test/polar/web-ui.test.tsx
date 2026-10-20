// @vitest-environment jsdom
/**
 * Polar on the web, on screen: its switch is in Polar's settings, beside the
 * other tools, and can be turned on only where the administrator allows it; each step says what it searched or read, and
 * an answer lists its sources and cites them by number.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

type Part = Record<string, unknown> & { type: string };
const chat = {
    messages: [] as Array<{ id: string; role: string; parts: Part[]; metadata?: unknown }>
};
let webAllowed = true;
let tools: Record<string, unknown> = {};
/** The panel's own storage; not every test environment has one. */
const kept = new Map<string, string>();

vi.mock("@ai-sdk/react", () => ({
    useChat: () => ({
        status: "ready",
        messages: chat.messages,
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
    useRouter: () => ({ push: () => undefined })
}));

beforeEach(() => {
    chat.messages = [];
    webAllowed = true;
    tools = {};
    kept.clear();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
        clear: () => kept.clear()
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            url === "/api/polar/models"
                ? Response.json({ providers: [], tools, isAdmin: false, web: webAllowed })
                : Response.json({})
        )
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const { PolarChat } = await import("@/components/polar/polar-panel");

const mount = () => render(<PolarChat />, { wrapper: MessagesWrapper });

function answer(parts: Part[]) {
    chat.messages = [
        { id: "u1", role: "user", parts: [{ type: "text", text: "How far is Polaris?" }] },
        { id: "a1", role: "assistant", parts, metadata: { workedMs: 4000 } }
    ];
}

const searched: Part = {
    type: "tool-search_web",
    toolCallId: "s1",
    state: "output-available",
    input: { query: "Polaris distance" },
    output: {
        ok: true,
        results: [{ url: "https://en.wikipedia.org/wiki/Polaris", title: "Polaris" }]
    }
};
const read: Part = {
    type: "tool-read_page",
    toolCallId: "r1",
    state: "output-available",
    input: { url: "https://www.nasa.gov/polaris" },
    output: { ok: true, url: "https://www.nasa.gov/polaris", title: "North Star facts" }
};

describe("Polar on the web", () => {
    it("keeps web search out of the composer, as a switch in Polar's settings", async () => {
        mount();
        await screen.findByRole("textbox");
        expect(screen.queryByRole("button", { name: "Search the web" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Polar settings" }));
        const toggle = await screen.findByRole("switch", { name: "Search the web" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(kept.get("polar.web")).toBe("off");
    });

    it("says the web is off, and cannot be switched on, where an administrator turned it off", async () => {
        webAllowed = false;
        mount();
        await screen.findByRole("textbox");
        // Give the models answer its turn to land.
        await new Promise((done) => setTimeout(done, 0));
        fireEvent.click(screen.getByRole("button", { name: "Polar settings" }));
        const toggle = await screen.findByRole("switch", { name: "Search the web" });
        expect((toggle as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText("Your administrator has turned web search off.")).toBeTruthy();
    });

    it("lists Polar's tools with a switch each, and remembers the ones switched off", async () => {
        tools = { read_tasks: { title: "Read tasks", writes: false, destructive: false } };
        mount();
        await screen.findByRole("textbox");
        await new Promise((done) => setTimeout(done, 0));
        fireEvent.click(screen.getByRole("button", { name: "Polar settings" }));
        const toggle = await screen.findByRole("switch", { name: "Read tasks" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        fireEvent.click(toggle);
        expect(kept.get("polar.toolsOff")).toBe(JSON.stringify(["read_tasks"]));
    });

    it("names what each step searched for and which site it read", async () => {
        answer([searched, read, { type: "text", text: "About 433 light-years." }]);
        mount();
        fireEvent.click(await screen.findByRole("button", { name: /Worked for 4 s/ }));
        expect(screen.getAllByText("Searching: Polaris distance").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Reading nasa.gov").length).toBeGreaterThan(0);
    });

    it("lists the sources under the answer and cites them by number", async () => {
        answer([
            searched,
            read,
            {
                type: "text",
                text: "About 433 light-years [NASA](https://www.nasa.gov/polaris)."
            }
        ]);
        mount();
        const list = await screen.findByRole("region", { name: "Sources" });
        const links = within(list).getAllByRole("link");
        expect(links.map((link) => link.getAttribute("href"))).toEqual([
            "https://en.wikipedia.org/wiki/Polaris",
            "https://www.nasa.gov/polaris"
        ]);
        expect(within(list).getByText("1 search - 1 page read")).toBeTruthy();
        const cited = screen.getByRole("link", { name: "[2]" });
        expect(cited.getAttribute("href")).toBe("https://www.nasa.gov/polaris");
        expect(cited.getAttribute("rel")).toContain("noopener");
    });

    it("shows no sources under an answer that used none", async () => {
        answer([{ type: "text", text: "Hello." }]);
        mount();
        await screen.findByText("Hello.");
        expect(screen.queryByRole("region", { name: "Sources" })).toBeNull();
    });
});
