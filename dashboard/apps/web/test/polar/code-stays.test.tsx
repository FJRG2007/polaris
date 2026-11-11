// @vitest-environment jsdom
/**
 * A task Polar answers itself in Code stays in Code: sending it shows the
 * conversation there instead of flipping the switch to Chat, and the
 * conversation reopens in Code with its repository. Fixture data throughout.
 */

import type { ReactNode } from "react";
import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Message = { id: string; role: string; parts: Array<{ type: string; text?: string }> };

const chats = new Map<string, Message[]>();
const sent: string[] = [];
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
                sendMessage: async (message: { text?: string }) => {
                    sent.push(message.text ?? "");
                },
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
    sent.length = 0;
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
                    value: {
                        sharedWorkspace: false,
                        repos: [{ id: "22222222-2222-4222-8222-222222222222", name: "acme/web" }],
                        hosts: [],
                        agents: []
                    }
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
            if (url === "/api/polar/threads/t-code") {
                return Response.json({
                    thread: {
                        id: "t-code",
                        projectId: null,
                        messages: [
                            {
                                id: "u1",
                                parentId: null,
                                role: "user",
                                parts: [{ type: "text", text: "What does the login form check?" }]
                            }
                        ],
                        queue: [],
                        choice: null,
                        code: { repo: "acme/web", branch: "" }
                    }
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
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
});

const { PolarChat, resetReloadForTests } = await import("@/components/polar/polar-panel");

function Wrapper({ children }: { children: ReactNode }) {
    return (
        <MessagesWrapper>
            <ToastProvider>{children}</ToastProvider>
        </MessagesWrapper>
    );
}

async function mountAt(address: string, mode: "chat" | "code" = "code") {
    stored.set("polar.mode", mode);
    window.history.replaceState(null, "", address);
    render(<PolarChat fullPage />, { wrapper: Wrapper });
    const codeOption = await screen.findByRole("radio", { name: /code/i });
    await waitFor(() => expect((codeOption as HTMLButtonElement).disabled).toBe(false));
}

describe("a task Polar answers in Code", () => {
    it("stays in Code once sent", async () => {
        await mountAt("/polar");
        const box = await screen.findByRole("textbox", { name: "Task for the agent" });
        await screen.findByRole("button", { name: /^Where the agent works: acme.web/ });
        fireEvent.change(box, { target: { value: "What does the login form check?" } });
        const send = screen.getByRole("button", { name: "Send (Enter)" }) as HTMLButtonElement;
        await waitFor(() => expect(send.disabled).toBe(false));
        fireEvent.click(send);
        await waitFor(() => expect(sent).toEqual(["What does the login form check?"]));
        expect(stored.get("polar.mode")).toBe("code");
        expect(screen.getByRole("radio", { name: /code/i }).getAttribute("aria-checked")).toBe(
            "true"
        );
        expect(screen.queryByRole("textbox", { name: "Task for the agent" })).toBeNull();
    });

    it("reopens in Code with its repository", async () => {
        await mountAt("/polar?thread=t-code", "chat");
        expect(await screen.findByText("What does the login form check?")).toBeTruthy();
        expect(stored.get("polar.mode")).toBe("code");
        expect(await screen.findByText(/acme.web/)).toBeTruthy();
    });
});
