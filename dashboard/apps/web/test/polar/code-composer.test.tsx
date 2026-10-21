// @vitest-environment jsdom
/**
 * Code types into Chat's own composer: the same attach, microphone, picker and
 * voice buttons in the same places, with what an agent session cannot take
 * switched off and the reason on the button. The repository and branch sit in
 * a bar above the task, whose menu offers GitHub's page for granting more
 * repositories. Nothing on either picker is written twice.
 *
 * `useChat` is replaced by a still store; everything else is real.
 */

import type { ReactNode } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const INSTALL = "https://github.com/apps/polaris-test/installations/new";

const CHOICES = {
    sharedWorkspace: false,
    installUrl: INSTALL as string | null,
    repos: [{ id: "22222222-2222-4222-8222-222222222222", name: "acme/web" }],
    hosts: [],
    agents: [
        {
            key: "claude",
            cli: "claude",
            label: "Claude Code",
            vendor: "Anthropic",
            docs: "",
            readiness: "ready",
            accountId: null,
            account: "This machine's own login",
            mine: null,
            machine: true,
            missing: []
        }
    ]
};

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
vi.mock("next/link", () => ({
    default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    )
}));

function answer(value: unknown): Response {
    return new Response(JSON.stringify({ value }), { status: 200 });
}

beforeEach(() => {
    CHOICES.installUrl = INSTALL;
    Element.prototype.scrollIntoView = () => undefined;
    for (const name of ["localStorage", "sessionStorage"]) {
        const stored = new Map<string, string>();
        vi.stubGlobal(name, {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => void stored.set(key, value),
            removeItem: (key: string) => void stored.delete(key),
            clear: () => stored.clear()
        });
    }
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url === "/api/polar/models")
                return Response.json({
                    providers: [
                        {
                            provider: "anthropic",
                            name: "Anthropic",
                            payers: ["own"],
                            models: [
                                {
                                    provider: "anthropic",
                                    model: "m-1",
                                    name: "Model One",
                                    reasoning: true
                                }
                            ]
                        }
                    ],
                    tools: {},
                    isAdmin: false,
                    voice: { dictation: true, speech: true, transcribers: [], transcriber: null }
                });
            if (url.startsWith("/api/polar/code/thread")) return answer(null);
            if (url.startsWith("/api/polar/code/choices")) return answer(CHOICES);
            if (url.startsWith("/api/polar/code"))
                return answer({ access: "manage", sessions: [], next: null });
            if (url === "/api/polar/threads") return Response.json({ threads: [] });
            return Response.json({});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const { PolarChat } = await import("@/components/polar/polar-panel");

/** The labels of the composer's buttons, in the order they are drawn. */
function composerButtons(box: HTMLElement): string[] {
    const form = box.closest("form");
    if (!form) throw new Error("the box is not in a composer");
    return within(form)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "");
}

async function openCode() {
    const codeOption = await screen.findByRole("radio", { name: /code/i });
    await waitFor(() => expect((codeOption as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(codeOption);
    const box = await screen.findByRole("textbox", { name: "Task for the agent" });
    await screen.findByRole("button", { name: /^Agent: Claude Code/ });
    return box;
}

function press(trigger: HTMLElement) {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("Code's composer is Chat's", () => {
    it("draws the same controls, with what a session cannot take switched off and why", async () => {
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await screen.findByText("Model One", { exact: false });
        const chatButtons = composerButtons(screen.getByLabelText("Message Polar"));
        expect(chatButtons).toEqual([
            "Stop sharing this page",
            "Attach files",
            "Dictate",
            "Microphone and model",
            "Model, intelligence and key",
            "Voice mode"
        ]);

        const box = await openCode();
        const codeButtons = composerButtons(box);
        // The microphone is the very same; attach and voice stay, refused.
        expect(codeButtons).toEqual([
            "An agent session can't take attached files yet",
            "Dictate",
            "Microphone and model",
            "Agent: Claude Code - This machine's own login",
            "Voice talks to Polar's chat, not to an agent"
        ]);
        const form = box.closest("form") as HTMLFormElement;
        const dictate = within(form).getByRole("button", { name: "Dictate" });
        expect((dictate as HTMLButtonElement).disabled).toBe(false);
        const attach = within(form).getByRole("button", { name: /attached files/ });
        expect(attach.getAttribute("aria-disabled")).toBe("true");
        const voice = within(form).getByRole("button", { name: /not to an agent/ });
        expect(voice.getAttribute("aria-disabled")).toBe("true");
        // Neither picker sits in the composer twice, and the repository is not in it.
        expect(within(form).getAllByText("Claude Code")).toHaveLength(1);
        expect(within(form).queryByText("acme/web")).toBeNull();
    });
});

describe("the repository bar", () => {
    it("names the repository once and offers to add repositories on GitHub", async () => {
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await openCode();
        const bar = screen.getByRole("button", { name: /^Where the agent works: acme\/web$/ });
        expect(bar.getAttribute("title")).toBe("acme/web");
        expect(screen.getAllByText("acme/web")).toHaveLength(1);

        press(bar);
        const add = await screen.findByRole("menuitem", { name: /Add repositories/ });
        expect(add.getAttribute("href")).toBe(INSTALL);
        expect(add.getAttribute("target")).toBe("_blank");
        expect(screen.getByRole("menuitem", { name: /No repository/ })).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: "Refresh the list" })).toBeTruthy();
        expect(screen.getByRole("textbox", { name: "Branch" })).toBeTruthy();
    });

    it("carries the branch typed in its menu into the bar", async () => {
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await openCode();
        press(screen.getByRole("button", { name: /^Where the agent works/ }));
        const branch = await screen.findByRole("textbox", { name: "Branch" });
        fireEvent.change(branch, { target: { value: "release/2.0" } });
        expect(
            // The menu hides the rest of the page from a screen reader while it is open.
            screen.getByRole("button", {
                name: "Where the agent works: acme/web - release/2.0",
                hidden: true
            })
        ).toBeTruthy();
    });

    it("says why there is nothing to add where no GitHub App is set up", async () => {
        CHOICES.installUrl = null;
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await openCode();
        press(screen.getByRole("button", { name: /^Where the agent works/ }));
        const add = await screen.findByRole("menuitem", { name: /Add repositories/ });
        expect(add.getAttribute("aria-disabled")).toBe("true");
        expect(add.textContent).toContain("No GitHub App is set up on this Polaris");
    });
});
