// @vitest-environment jsdom
/**
 * Polar on the web, on screen: the composer's switch appears only where the
 * administrator allows the web, each step says what it searched or read, and
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
    try {
        window.sessionStorage.clear();
        window.localStorage.clear();
    } catch {
        // No storage in this environment.
    }
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            url === "/api/polar/models"
                ? Response.json({ providers: [], tools: {}, isAdmin: false, web: webAllowed })
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
    it("shows the composer's web switch where the web is allowed, and remembers it off", async () => {
        mount();
        const toggle = await screen.findByRole("button", { name: "Search the web" });
        expect(toggle.getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-pressed")).toBe("false");
        // Remembered where this environment has storage at all.
        let stored: string | null = "off";
        try {
            stored = window.localStorage.getItem("polar.web");
        } catch {
            // No storage here.
        }
        expect(stored).toBe("off");
    });

    it("has no web switch where an administrator turned the web off", async () => {
        webAllowed = false;
        mount();
        await screen.findByRole("textbox");
        // Give the models answer its turn to land.
        await new Promise((done) => setTimeout(done, 0));
        expect(screen.queryByRole("button", { name: "Search the web" })).toBeNull();
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
