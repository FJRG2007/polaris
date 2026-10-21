// @vitest-environment jsdom
/**
 * The page a person is on goes to Polar as background context, never as a chip
 * in the composer, and only while "Share the page you're on" is on in Polar's
 * settings.
 *
 * `useChat` is replaced by a store the test drives, and the transport's
 * request builder is caught so what a turn would send can be read.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

type Prepare = (input: { messages: unknown[] }) => { body: Record<string, unknown> };
let prepare: Prepare | null = null;
/** The panel's own storage; not every test environment has one. */
const kept = new Map<string, string>();

vi.mock("ai", async (original) => ({
    ...(await original<typeof import("ai")>()),
    DefaultChatTransport: class {
        constructor(options: { prepareSendMessagesRequest: Prepare }) {
            prepare = options.prepareSendMessagesRequest;
        }
    }
}));
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
    useRouter: () => ({ push: () => undefined })
}));

const PROVIDERS = [
    {
        provider: "anthropic",
        name: "Anthropic",
        payers: ["own"],
        models: [{ provider: "anthropic", model: "m-1", name: "Model One", reasoning: true }]
    }
];

beforeEach(() => {
    prepare = null;
    kept.clear();
    document.title = "Sprint board";
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
                ? Response.json({ providers: PROVIDERS, tools: {}, isAdmin: false })
                : Response.json({})
        )
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const { PolarChat } = await import("@/components/polar/polar-panel");

async function mount() {
    render(<PolarChat />, { wrapper: MessagesWrapper });
    await screen.findByText("Model One", { exact: false });
}

const sent = () => prepare!({ messages: [] }).body;

describe("the page Polar is asked on", () => {
    it("goes with the turn without a chip in the composer", async () => {
        await mount();
        expect(sent().context).toMatchObject({ route: "/tasks", title: "Sprint board" });
        const composer = screen.getByLabelText("Message Polar").closest("form")!;
        expect(composer.textContent).not.toContain("Sprint board");
        expect(composer.textContent).not.toContain("/tasks");
        expect(screen.queryByText("Sprint board")).toBeNull();
    });

    it("is left out of the request while sharing is switched off in settings", async () => {
        kept.set("polar.sharePage", "off");
        await mount();
        await waitFor(() => expect(sent().context).toBeNull());
    });
});
