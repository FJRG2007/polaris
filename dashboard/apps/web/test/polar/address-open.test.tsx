// @vitest-environment jsdom
/**
 * /polar opens what its address names, as the settings page's list sends it:
 * `?thread=` opens that chat and `?new=` starts one, both in Chat even when
 * Code was the side last on screen, and the address goes back to plain /polar.
 */

import type { ReactNode } from "react";
import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

type Message = { id: string; role: string; parts: Array<{ type: string; text?: string }> };

const chats = new Map<string, Message[]>();
const stored = new Map<string, string>();

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
    usePathname: () => "/polar",
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
    stored.clear();
    Element.prototype.scrollIntoView = () => undefined;
    for (const name of ["localStorage", "sessionStorage"]) {
        const area = name === "localStorage" ? stored : new Map<string, string>();
        vi.stubGlobal(name, {
            getItem: (key: string) => area.get(key) ?? null,
            setItem: (key: string, value: string) => void area.set(key, value),
            removeItem: (key: string) => void area.delete(key),
            clear: () => area.clear()
        });
    }
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url === "/api/polar/models") {
                return Response.json({ providers: PROVIDERS, tools: {}, isAdmin: false });
            }
            if (url.startsWith("/api/polar/code/choices")) {
                return Response.json({
                    value: { sharedWorkspace: false, repos: [], hosts: [], agents: [] }
                });
            }
            if (url.startsWith("/api/polar/code")) {
                return Response.json({ value: { access: "manage", sessions: [], next: null } });
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
    window.history.replaceState(null, "", "/");
});

const { PolarChat } = await import("@/components/polar/polar-panel");

function Wrapper({ children }: { children: ReactNode }) {
    return (
        <MessagesWrapper>
            <ToastProvider>{children}</ToastProvider>
        </MessagesWrapper>
    );
}

async function mountAt(address: string) {
    stored.set("polar.mode", "code");
    window.history.replaceState(null, "", address);
    render(<PolarChat fullPage />, { wrapper: Wrapper });
    const codeOption = await screen.findByRole("radio", { name: /code/i });
    await waitFor(() => expect((codeOption as HTMLButtonElement).disabled).toBe(false));
}

describe("an address that names what /polar opens", () => {
    it("stays in Code when the address names nothing", async () => {
        await mountAt("/polar");
        expect(await screen.findByRole("textbox", { name: "Task for the agent" })).toBeTruthy();
    });

    it("opens the named chat in Chat", async () => {
        await mountAt("/polar?thread=t-old");
        expect(await screen.findByText("What was said before")).toBeTruthy();
        expect(screen.queryByRole("textbox", { name: "Task for the agent" })).toBeNull();
        expect(stored.get("polar.mode")).toBe("chat");
        expect(window.location.search).toBe("");
    });

    it("starts a new chat in Chat", async () => {
        stored.set("polar.thread", "t-old");
        await mountAt("/polar?new=1");
        expect(screen.queryByRole("textbox", { name: "Task for the agent" })).toBeNull();
        expect(stored.get("polar.mode")).toBe("chat");
        expect(stored.get("polar.thread")).toBe("");
        expect(window.location.search).toBe("");
        expect(
            vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/polar/threads/t-old")
        ).toBe(false);
    });
});
