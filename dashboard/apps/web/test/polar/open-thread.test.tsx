// @vitest-environment jsdom
/**
 * A stored chat opens on the first click. `useChat` makes a new chat for every
 * id, as the SDK does: messages set on the chat in hand while the id changes
 * land on the one being replaced, and the thread opened empty until a second
 * click, when its id was already the current one.
 *
 * `useChat` is replaced by a store keyed by id, like the SDK's; everything else
 * is real.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Message = { id: string; role: string; parts: Array<{ type: string; text?: string }> };

const chats = new Map<string, Message[]>();

vi.mock("@ai-sdk/react", async () => {
    const { useState } = await import("react");
    return {
        useChat: (options: { id: string; messages?: Message[] }) => {
            const [, redraw] = useState(0);
            if (!chats.has(options.id)) chats.set(options.id, options.messages ?? []);
            const id = options.id;
            return {
                id,
                status: "ready",
                messages: chats.get(id)!,
                error: undefined,
                sendMessage: async () => undefined,
                stop: async () => undefined,
                // Bound to the chat of this render, as the SDK's is.
                setMessages: (next: Message[]) => {
                    chats.set(id, next);
                    redraw((count) => count + 1);
                },
                regenerate: async () => undefined,
                addToolApprovalResponse: async () => undefined
            };
        }
    };
});
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
    chats.clear();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url === "/api/polar/models") {
                return Response.json({ providers: PROVIDERS, tools: {}, isAdmin: false });
            }
            if (url === "/api/polar/threads") {
                return Response.json({
                    threads: [{ id: "t-old", title: "Old chat", updatedAt: "2026-10-19T00:00:00Z" }]
                });
            }
            if (url === "/api/polar/threads/t-old") {
                return Response.json({
                    thread: {
                        id: "t-old",
                        projectId: null,
                        messages: [
                            {
                                id: "u1",
                                parentId: null,
                                role: "user",
                                parts: [{ type: "text", text: "What was said before" }]
                            }
                        ],
                        queue: [],
                        choice: null
                    }
                });
            }
            return Response.json({});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const { PolarChat } = await import("@/components/polar/polar-panel");

describe("opening a stored chat", () => {
    it("shows its messages after one click", async () => {
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await waitFor(() => expect(screen.getByText("Model One", { exact: false })).toBeTruthy());
        fireEvent.click(screen.getByLabelText("Conversations"));
        fireEvent.click(await screen.findByText("Old chat"));
        expect(await screen.findByText("What was said before")).toBeTruthy();
    });
});
