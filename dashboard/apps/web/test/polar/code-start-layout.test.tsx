// @vitest-environment jsdom
/**
 * Code in the side panel opens without anything moving: the chips under the
 * composer are drawn from the first paint and only switch on when access and
 * the choices land. The repository picked last - "No repository" included - is
 * the one shown, in every open Code. And "/" lists the person's skills and
 * their own commands, on Chat's list.
 */

import type { ReactNode } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { codeSourcesFor } from "@/lib/polar/agents/code-sources";

const INSTALL = "https://github.com/apps/polaris-test/installations/new";

/** Claude Code signed in on the machine itself: the machine's sign-in source. */
const AGENTS = [
    {
        key: "claude",
        cli: "claude",
        label: "Claude Code",
        vendor: "Anthropic",
        docs: "",
        readiness: "ready" as const,
        accountId: null,
        account: "This machine's own login",
        mine: null,
        machine: true,
        apiKey: false,
        missing: []
    }
];

const CHOICES = {
    sharedWorkspace: false,
    installUrl: INSTALL as string | null,
    repos: [{ id: "22222222-2222-4222-8222-222222222222", name: "acme/web" }],
    skills: [{ name: "review", description: "Review the change" }],
    hosts: [],
    agents: AGENTS,
    code: {
        sources: codeSourcesFor(AGENTS),
        personas: [],
        polarPolicy: { models: [], modelPolicy: "preferred" }
    }
};

/** The model picker on a Claude source, on its own default model. */
const PICKED = "Model: Default model - Claude subscription";

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

const OWN = {
    id: "33333333-3333-4333-8333-333333333333",
    shortcut: "tidy",
    prompt: "Tidy the imports",
    choice: { kind: "automatic" }
};

let gate = Promise.withResolvers<void>();

beforeEach(() => {
    gate = Promise.withResolvers<void>();
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
    // These follow a coding agent's session; Polar's own answers are tested on their
    // own. Kept as it was before Code was model-first: read as the machine's sign-in.
    window.localStorage.setItem("polar.code.agent", "tool:claude");
    // The panel was left on Code.
    window.localStorage.setItem("polar.mode", "code");
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
            if (url.startsWith("/api/polar/code/choices")) {
                await gate.promise;
                return answer(CHOICES);
            }
            if (url === "/api/polar/commands")
                return Response.json({ commands: [OWN] });
            if (url.startsWith("/api/polar/code/branches"))
                return answer({ defaultBranch: "main", branches: ["main", "dev", "release/2.0"] });
            if (url.startsWith("/api/polar/code")) {
                await gate.promise;
                return answer({ access: "manage", sessions: [], next: null });
            }
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
const { initialRepo } = await import("@/components/polar/polar-code");

const REPO = "22222222-2222-4222-8222-222222222222";

/** The chips under the composer, by what they are for. */
function chips(): string[] {
    return screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? "")
        .filter((label) => /^(Where the agent works|Issue|Skill):/.test(label))
        .map((label) => label.split(":")[0] ?? "");
}

describe("Code opens without moving", () => {
    it("draws the chips under the composer before access and the choices land", async () => {
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await screen.findByRole("textbox", { name: "Task for the agent" });
        const before = chips();
        expect(before).toEqual(["Where the agent works", "Issue", "Skill"]);
        const skill = screen.getByRole("button", { name: /^Skill:/ });
        expect((skill as HTMLButtonElement).disabled).toBe(true);
        gate.resolve();
        await waitFor(() =>
            expect(
                (screen.getByRole("button", { name: /^Skill:/ }) as HTMLButtonElement).disabled
            ).toBe(false)
        );
        expect(chips()).toEqual(before);
    });
});

describe("No repository is a pick like any other", () => {
    it("opens on No repository when that was picked last", async () => {
        window.localStorage.setItem("polar.code.repo", "workspace");
        gate.resolve();
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await waitFor(() =>
            expect(screen.getByRole("button", { name: /^Where the agent works:/ }).getAttribute("aria-label")).toBe(
                "Where the agent works: No repository"
            )
        );
        expect(screen.queryByRole("button", { name: /^Issue:/ })).toBeNull();
    });

    it("follows a pick made in another open Code, No repository included", async () => {
        window.localStorage.setItem("polar.code.repo", REPO);
        gate.resolve();
        render(<PolarChat />, { wrapper: MessagesWrapper });
        const where = () =>
            screen.getByRole("button", { name: /^Where the agent works:/ }).getAttribute("aria-label");
        await waitFor(() => expect(where()).toMatch(/acme\/web/));
        act(() => {
            window.dispatchEvent(
                new StorageEvent("storage", { key: "polar.code.repo", newValue: "workspace" })
            );
        });
        await waitFor(() => expect(where()).toBe("Where the agent works: No repository"));
        act(() => {
            window.dispatchEvent(new CustomEvent("polar:code-repo", { detail: REPO }));
        });
        await waitFor(() => expect(where()).toMatch(/acme\/web/));
    });

    it("keeps the stored pick when the choices are already known", () => {
        const known = { ...CHOICES } as unknown as Parameters<typeof initialRepo>[0];
        expect(initialRepo(known, "workspace")).toBe("workspace");
        expect(initialRepo(known, REPO)).toBe(REPO);
        expect(initialRepo(known, "gone")).toBe("");
        expect(initialRepo(null, "workspace")).toBe("");
    });
});

describe("Code's slash commands", () => {
    it("lists the skills and the person's commands, and a skill picked is the task's", async () => {
        gate.resolve();
        render(<PolarChat />, { wrapper: MessagesWrapper });
        const box = await screen.findByRole("textbox", { name: "Task for the agent" });
        await waitFor(() =>
            expect(
                (screen.getByRole("button", { name: /^Skill:/ }) as HTMLButtonElement).disabled
            ).toBe(false)
        );
        fireEvent.change(box, { target: { value: "/" } });
        const list = await screen.findByRole("listbox", { name: "Commands" });
        expect(within(list).getByText("/review")).toBeTruthy();
        await waitFor(() => expect(within(list).getByText("/tidy")).toBeTruthy());
        // Code's own four come first: /help, /resume, /model and /clear.
        expect(within(list).getByText("/model")).toBeTruthy();
        for (let step = 0; step < 4; step++) fireEvent.keyDown(box, { key: "ArrowDown" });
        fireEvent.keyDown(box, { key: "Enter" });
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Skill: review" })).toBeTruthy()
        );
        expect((box as HTMLTextAreaElement).value).toBe("");
        expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    });
});
