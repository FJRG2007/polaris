// @vitest-environment jsdom
/**
 * An answer's thinking and tool calls fold into one line above it: closed by
 * default, saying how long the turn worked and how many tools it used, opening
 * into the timeline on a click and remembering that for the tab. A call waiting
 * for an approval and a call that failed stay in view without opening anything.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

type Part = Record<string, unknown> & { type: string };
const chat = {
    status: "ready" as "ready" | "streaming",
    messages: [] as Array<{ id: string; role: string; parts: Part[]; metadata?: unknown }>
};

vi.mock("@ai-sdk/react", () => ({
    useChat: () => ({
        status: chat.status,
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

const TOOLS = {
    list_deployments: { title: "List deployments", writes: false, destructive: false },
    delete_task: { title: "Delete task", writes: true, destructive: true }
};

const done = (id: string): Part => ({
    type: "tool-list_deployments",
    toolCallId: id,
    state: "output-available",
    input: {},
    output: { ok: true }
});

function answer(parts: Part[], metadata: unknown = { workedMs: 38_000 }) {
    chat.messages = [
        { id: "u1", role: "user", parts: [{ type: "text", text: "What is deployed?" }] },
        { id: "a1", role: "assistant", parts, metadata }
    ];
}

beforeEach(() => {
    chat.status = "ready";
    chat.messages = [];
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
                ? Response.json({ providers: [], tools: TOOLS, isAdmin: false })
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

const workLine = () => screen.getByRole("button", { name: /worked for|used|thought for/i });

describe("an answer's work", () => {
    it("folds every thought and call into one closed line with its time and count", async () => {
        answer([
            { type: "reasoning", text: "Let me look." },
            done("c1"),
            { type: "reasoning", text: "And again." },
            done("c2"),
            done("c3"),
            { type: "text", text: "Three apps are deployed." }
        ]);
        mount();
        const line = await screen.findByRole("button", { name: "Worked for 38 s - 3 tools" });
        expect(line.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByText("List deployments")).toBeNull();
        expect(screen.queryByText("Let me look.")).toBeNull();
        expect(screen.getByText("Three apps are deployed.")).toBeTruthy();
    });

    it("says one tool in the singular, and the count alone when the time is unknown", async () => {
        answer([done("c1"), { type: "text", text: "One." }], {});
        mount();
        expect(await screen.findByRole("button", { name: "Used 1 tool" })).toBeTruthy();
    });

    it("opens into the timeline and closes again, remembered for the tab", async () => {
        answer([{ type: "reasoning", text: "Let me look." }, done("c1"), done("c2")]);
        const view = mount();
        fireEvent.click(await screen.findByRole("button", { name: /Worked for 38 s/ }));
        expect(workLine().getAttribute("aria-expanded")).toBe("true");
        expect(screen.getAllByText("List deployments")).toHaveLength(2);
        view.unmount();
        mount();
        expect(workLine().getAttribute("aria-expanded")).toBe("true");
        fireEvent.click(workLine());
        expect(workLine().getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByText("List deployments")).toBeNull();
    });

    it("keeps a call waiting for an approval in view", async () => {
        answer(
            [
                done("c1"),
                {
                    type: "tool-delete_task",
                    toolCallId: "c2",
                    state: "approval-requested",
                    input: { id: "ENG-1" },
                    approval: { id: "ap-1" }
                }
            ],
            {}
        );
        mount();
        expect(await screen.findByRole("button", { name: "Used 2 tools" })).toBeTruthy();
        expect(screen.getAllByText(/Delete task/).length).toBeGreaterThan(0);
    });

    it("marks a failed call on the line and shows that call, opened", async () => {
        answer([
            done("c1"),
            {
                type: "tool-list_deployments",
                toolCallId: "c2",
                state: "output-error",
                input: {},
                errorText: "The host did not answer"
            },
            { type: "text", text: "I could not reach one host." }
        ]);
        mount();
        expect(await screen.findByRole("button", { name: /1 step failed/ })).toBeTruthy();
        expect(screen.getByText("The host did not answer")).toBeTruthy();
    });

    it("shows the current step as one line while the turn runs", async () => {
        chat.status = "streaming";
        answer([
            done("c1"),
            { type: "tool-list_deployments", toolCallId: "c2", state: "input-available", input: {} }
        ]);
        mount();
        expect(await screen.findByText("List deployments...")).toBeTruthy();
        expect(screen.queryAllByText("List deployments")).toHaveLength(0);
    });

    it("stops saying it thinks once the answer is being written", async () => {
        chat.status = "streaming";
        answer([done("c1"), { type: "step-start" }, { type: "text", text: "One app" }], {});
        mount();
        expect(await screen.findByRole("button", { name: "Used 1 tool" })).toBeTruthy();
        expect(screen.queryByText(/Thinking/)).toBeNull();
    });
});
