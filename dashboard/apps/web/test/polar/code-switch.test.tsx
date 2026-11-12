// @vitest-environment jsdom
/**
 * The Chat / Code switch: Code is switched off, with the reason, for an account
 * that cannot open Agents; a reader follows sessions without starting one; and
 * sending a task starts it through Polar's Code start route, from Chat's own
 * composer, and opens it as a thread.
 */

import type { ReactNode } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { accountSourceKey, codeSourcesFor } from "@/lib/polar/agents/code-sources";

const started: unknown[] = [];

/** A Claude subscription linked on Account > AI keys: Claude Code runs it. */
const PLAN = "0190c6a0-0000-7000-8000-0000000000a1";
const AGENTS = [
    {
        key: `claude:${PLAN}`,
        cli: "claude",
        label: "Claude Code",
        vendor: "Anthropic",
        docs: "",
        readiness: "ready" as const,
        accountId: PLAN,
        account: "me@example.test",
        mine: true,
        machine: false,
        apiKey: false,
        env: "CLAUDE_CODE_OAUTH_TOKEN",
        missing: []
    }
];

const CHOICES = {
    sharedWorkspace: false,
    installUrl: "https://github.com/apps/polaris-test/installations/new",
    repos: [{ id: "22222222-2222-4222-8222-222222222222", name: "acme/web" }],
    hosts: [],
    agents: AGENTS,
    code: {
        sources: codeSourcesFor(AGENTS),
        personas: [],
        polarPolicy: { models: [], modelPolicy: "preferred" }
    }
};

function answer(value: unknown): Response {
    return new Response(JSON.stringify({ value }), { status: 200 });
}

vi.mock("next/link", () => ({
    default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    )
}));

const { codeBlocks, PolarCodeView, PolarModeSwitch, titleFromPrompt, usePolarCode } =
    await import("@/components/polar/polar-code");

let access: "none" | "read" | "manage" = "none";

/** Chat's microphone as Polar's chat lends it to Code. */
const KIT = {
    voice: { dictation: true, speech: false, transcribers: [], transcriber: null },
    payer: null,
    onTranscriber: () => undefined,
    isAdmin: false
};
let thread: unknown = null;

/** The switch, the history's rows as the sidebar offers them, and the side on screen. */
const PROVIDERS = [
    {
        provider: "anthropic",
        name: "Anthropic",
        payers: ["own" as const],
        models: [{ provider: "anthropic", model: "claude-sonnet", name: "Claude Sonnet", reasoning: true }]
    }
];
const polarTasks: unknown[] = [];

function Harness() {
    const code = usePolarCode();
    return (
        <>
            <PolarModeSwitch code={code} />
            <ul>
                {(code.history.rows ?? []).map((row) => (
                    <li key={row.id}>
                        <button type="button" onClick={() => code.open(row.id)}>
                            {row.title}
                        </button>
                    </li>
                ))}
            </ul>
            {code.mode === "code" ? (
                <PolarCodeView
                    code={code}
                    fullPage={false}
                    avatar={null}
                    voiceKit={KIT}
                    providers={PROVIDERS}
                    onPolarTask={(task) => polarTasks.push(task)}
                />
            ) : (
                <p>chat-view</p>
            )}
        </>
    );
}

beforeEach(() => {
    started.length = 0;
    thread = null;
    // jsdom lays nothing out, so it has no scrolling to do.
    Element.prototype.scrollIntoView = () => undefined;
    // This environment has no storage of its own; the switch's memory needs one.
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
    // own. Kept as it was before Code was model-first: read as the subscription.
    window.localStorage.setItem("polar.code.agent", "tool:claude");
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            if (url.startsWith("/api/polar/code/thread")) return answer(thread);
            if (url.startsWith("/api/polar/code/choices")) return answer(CHOICES);
            if (url.startsWith("/api/polar/code/start")) {
                started.push(JSON.parse(String(init?.body)));
                return answer({ id: "33333333-3333-4333-8333-333333333333" });
            }
            if (url.startsWith("/api/polar/code/prompt")) return answer({});
            return answer({ access, sessions: [], next: null });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("titleFromPrompt", () => {
    it("takes the first line and cuts it to the title's bound", () => {
        expect(titleFromPrompt("  Fix the login form\nand its tests")).toBe("Fix the login form");
        const long = titleFromPrompt("x".repeat(200));
        expect(long.length).toBeLessThanOrEqual(80);
        expect(long.endsWith("...")).toBe(true);
    });
});

describe("the Chat / Code switch", () => {
    it("keeps Code switched off, with the reason, without Agents", async () => {
        access = "none";
        render(<Harness />, { wrapper: MessagesWrapper });
        const codeOption = await screen.findByRole("radio", { name: /code/i });
        await waitFor(() => expect((codeOption as HTMLButtonElement).disabled).toBe(true));
        expect(codeOption.getAttribute("title")).toMatch(/cannot open Agents/);
        expect(screen.getByText("chat-view")).toBeTruthy();
    });

    it("starts a session through the Code start route, Enigma on", async () => {
        access = "manage";
        render(<Harness />, { wrapper: MessagesWrapper });
        const codeOption = await screen.findByRole("radio", { name: /code/i });
        await waitFor(() => expect((codeOption as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(codeOption);
        const box = await screen.findByRole("textbox", { name: "Task for the agent" });
        await screen.findByRole("button", { name: /^Where the agent works: acme\/web/ });
        fireEvent.change(box, { target: { value: "Fix the login form\nwith tests" } });
        const send = screen.getByRole("button", { name: "Start session" }) as HTMLButtonElement;
        await waitFor(() => expect(send.disabled).toBe(false));
        fireEvent.click(send);
        await waitFor(() => expect(started).toHaveLength(1));
        expect(started[0]).toMatchObject({
            repoId: "22222222-2222-4222-8222-222222222222",
            title: "Fix the login form",
            // The source and model, never the tool: the server resolves that.
            pick: { source: accountSourceKey(PLAN), model: null },
            prompt: "Fix the login form\nwith tests",
            enigma: { enabled: true }
        });
        // The new session opens in the thread, which reads it.
        await waitFor(() =>
            expect(
                vi
                    .mocked(fetch)
                    .mock.calls.some(([url]) =>
                        String(url).includes("33333333-3333-4333-8333-333333333333")
                    )
            ).toBe(true)
        );
    });

    it("answers on Automatic by default, as Chat does, about the picked repository, starting nothing", async () => {
        access = "manage";
        polarTasks.length = 0;
        window.localStorage.removeItem("polar.code.agent");
        render(<Harness />, { wrapper: MessagesWrapper });
        const codeOption = await screen.findByRole("radio", { name: /code/i });
        await waitFor(() => expect((codeOption as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(codeOption);
        const box = await screen.findByRole("textbox", { name: "Task for the agent" });
        await screen.findByRole("button", { name: /^Model: Automatic/ });
        await screen.findByRole("button", { name: /^Where the agent works: acme\/web/ });
        fireEvent.change(box, { target: { value: "What does the login form validate?" } });
        const send = screen.getByRole("button", { name: "Send (Enter)" }) as HTMLButtonElement;
        await waitFor(() => expect(send.disabled).toBe(false));
        fireEvent.click(send);
        expect(polarTasks).toEqual([
            {
                text: "What does the login form validate?",
                // Not the first model listed: a key may have no credit for it.
                choice: expect.objectContaining({ provider: "auto", model: "auto" }),
                code: { repo: "acme/web", branch: "" }
            }
        ]);
        expect(started).toHaveLength(0);
    });

    it("lets a reader follow sessions but not start one", async () => {
        access = "read";
        window.localStorage.setItem("polar.mode", "code");
        render(<Harness />, { wrapper: MessagesWrapper });
        expect(await screen.findByText(/needs permission to manage Agents/)).toBeTruthy();
        const box = screen.getByRole("textbox", {
            name: "Task for the agent"
        }) as HTMLTextAreaElement;
        expect(box.disabled).toBe(true);
    });

    it("keeps No repository picked across a reload", async () => {
        access = "manage";
        window.localStorage.setItem("polar.mode", "code");
        render(<Harness />, { wrapper: MessagesWrapper });
        const trigger = await screen.findByRole("button", { name: /^Where the agent works: acme.web/ });
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
        fireEvent.click(await screen.findByRole("menuitem", { name: /No repository/ }));
        await screen.findByRole("button", { name: /^Where the agent works: No repository/ });
        cleanup();
        render(<Harness />, { wrapper: MessagesWrapper });
        expect(await screen.findByRole("button", { name: /^Where the agent works: No repository/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /^Where the agent works: acme.web/ })).toBeNull();
    });

    it("starts on the first repository when the one picked last is gone", async () => {
        access = "manage";
        window.localStorage.setItem("polar.mode", "code");
        window.localStorage.setItem("polar.code.repo", "99999999-9999-4999-8999-999999999999");
        render(<Harness />, { wrapper: MessagesWrapper });
        expect(await screen.findByRole("button", { name: /^Where the agent works: acme.web/ })).toBeTruthy();
    });

    it("does not say the agent is getting ready on a session that ended", async () => {
        access = "manage";
        const row = {
            id: "33333333-3333-4333-8333-333333333333",
            title: "Fix the login form",
            repo: "acme/web",
            branch: "",
            state: "stopped",
            stateLabel: "Stopped",
            live: false,
            createdAt: "2026-01-01T00:00:00.000Z"
        };
        thread = { session: row, entries: [], error: null };
        vi.mocked(fetch).mockImplementation(async (url) => {
            if (String(url).startsWith("/api/polar/code/thread")) return answer(thread);
            if (String(url).startsWith("/api/polar/code/choices")) return answer(CHOICES);
            return answer({ access, sessions: [row], next: null });
        });
        window.localStorage.setItem("polar.mode", "code");
        render(<Harness />, { wrapper: MessagesWrapper });
        fireEvent.click(await screen.findByRole("button", { name: /Fix the login form/ }));
        expect(await screen.findByText(/This session has ended/)).toBeTruthy();
        expect(screen.queryByText(/getting its machine ready/)).toBeNull();
    });

    it("does not call a session gone when its first read fails, and tries again", async () => {
        access = "manage";
        const row = {
            id: "33333333-3333-4333-8333-333333333333",
            title: "Fix the login form",
            repo: "acme/web",
            branch: "",
            state: "stopped",
            stateLabel: "Stopped",
            live: false,
            createdAt: "2026-01-01T00:00:00.000Z"
        };
        let fail = true;
        vi.mocked(fetch).mockImplementation(async (url) => {
            if (String(url).startsWith("/api/polar/code/thread"))
                return fail
                    ? new Response("", { status: 500 })
                    : answer({ session: row, entries: [], error: null });
            if (String(url).startsWith("/api/polar/code/choices")) return answer(CHOICES);
            return answer({ access, sessions: [row], next: null });
        });
        window.localStorage.setItem("polar.mode", "code");
        render(<Harness />, { wrapper: MessagesWrapper });
        fireEvent.click(await screen.findByRole("button", { name: /Fix the login form/ }));
        expect(await screen.findByText("Couldn't load this session.")).toBeTruthy();
        expect(screen.queryByText(/no longer available/)).toBeNull();
        fail = false;
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText(/This session has ended/)).toBeTruthy();
    });

    it("does not call somebody a reader before their access is known", async () => {
        vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));
        window.localStorage.setItem("polar.mode", "code");
        render(<Harness />, { wrapper: MessagesWrapper });
        expect(await screen.findByRole("textbox", { name: "Task for the agent" })).toBeTruthy();
        expect(screen.queryByText(/needs permission to manage Agents/)).toBeNull();
    });
});

describe("codeBlocks", () => {
    const entry = (type: "message" | "event", text: string) => ({
        at: "2026-10-20T10:00:00.000Z",
        type,
        role: type === "message" ? "user" : "tool.start",
        text,
        detail: ""
    });

    it("keeps each message apart and folds the steps between two of them", () => {
        const blocks = codeBlocks([
            entry("event", "Started"),
            entry("message", "Fix it"),
            entry("event", "Edit"),
            entry("event", "Bash"),
            entry("message", "Done")
        ]);
        expect(blocks.map((block) => block.kind)).toEqual(["work", "message", "work", "message"]);
        expect(blocks[2]).toMatchObject({ entries: [{ text: "Edit" }, { text: "Bash" }] });
    });

    it("is empty for a thread with nothing in it", () => {
        expect(codeBlocks([])).toEqual([]);
    });
});

describe("the Code thread", () => {
    it("draws the session as a chat: bubbles, and its steps folded", async () => {
        access = "manage";
        const row = {
            id: "33333333-3333-4333-8333-333333333333",
            title: "Fix the login form",
            repo: "acme/web",
            branch: "polaris/fix",
            state: "idle",
            stateLabel: "Idle",
            live: true,
            createdAt: "2026-01-01T00:00:00.000Z"
        };
        thread = {
            session: row,
            entries: [
                { at: "1", type: "message", role: "user", text: "Fix it", detail: "" },
                { at: "2", type: "event", role: "tool.start", text: "Tool", detail: "Edit" },
                { at: "3", type: "message", role: "agent", text: "**Done**", detail: "" }
            ],
            error: null
        };
        vi.mocked(fetch).mockImplementation(async (url) => {
            if (String(url).startsWith("/api/polar/code/thread")) return answer(thread);
            if (String(url).startsWith("/api/polar/code/choices")) return answer(CHOICES);
            return answer({ access, sessions: [row], next: null });
        });
        window.localStorage.setItem("polar.mode", "code");
        render(<Harness />, { wrapper: MessagesWrapper });
        fireEvent.click(await screen.findByRole("button", { name: /Fix the login form/ }));
        expect(await screen.findByText("Fix it")).toBeTruthy();
        // The agent's words are Markdown, as an answer in Chat is.
        expect((await screen.findByText("Done")).tagName).toBe("STRONG");
        expect(screen.getByRole("button", { name: "1 step" })).toBeTruthy();
        expect(screen.getByRole("textbox", { name: "Reply to the agent" })).toBeTruthy();
    });
});

describe("how the agent asks before it acts", () => {
    const live = {
        id: "33333333-3333-4333-8333-333333333333",
        title: "Fix the login form",
        repo: "acme/web",
        branch: "",
        state: "running",
        stateLabel: "Running",
        live: true,
        createdAt: "2026-01-01T00:00:00.000Z"
    };

    it("starts Claude Code on the mode picked, and starts the next task on it too", async () => {
        access = "manage";
        render(<Harness />, { wrapper: MessagesWrapper });
        const codeOption = await screen.findByRole("radio", { name: /code/i });
        await waitFor(() => expect((codeOption as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(codeOption);
        const box = await screen.findByRole("textbox", { name: "Task for the agent" });
        await screen.findByRole("button", { name: /^Where the agent works: acme\/web/ });
        const mode = screen.getByRole("button", { name: "Permissions: Full access" });
        fireEvent.pointerDown(mode, { button: 0, ctrlKey: false });
        fireEvent.click(await screen.findByRole("menuitem", { name: /Ask first/ }));
        expect(screen.getByRole("button", { name: "Permissions: Ask first" })).toBeTruthy();
        fireEvent.change(box, { target: { value: "Fix the login form" } });
        const send = screen.getByRole("button", { name: "Start session" }) as HTMLButtonElement;
        await waitFor(() => expect(send.disabled).toBe(false));
        fireEvent.click(send);
        await waitFor(() => expect(started).toHaveLength(1));
        expect(started[0]).toMatchObject({
            pick: { source: accountSourceKey(PLAN) },
            permissionMode: "ask"
        });
        expect(started[0]).not.toHaveProperty("cli");
        expect(window.localStorage.getItem("polar.code.permissionMode")).toBe("ask");
    });

    it("puts a waiting question where the reply goes, and sends the answer", async () => {
        access = "manage";
        const answered: unknown[] = [];
        thread = {
            session: live,
            entries: [],
            error: null,
            canManage: false,
            permission: {
                id: "44444444-4444-4444-8444-444444444444",
                tool: "Bash",
                detail: "rm -rf build",
                at: "2026-01-01T00:00:01.000Z"
            }
        };
        vi.mocked(fetch).mockImplementation(async (url, init) => {
            if (String(url).startsWith("/api/polar/code/thread")) return answer(thread);
            if (String(url).startsWith("/api/polar/code/choices")) return answer(CHOICES);
            if (String(url) === "/api/agents/sessions/permission") {
                answered.push(JSON.parse(String(init?.body)));
                thread = { ...(thread as object), permission: null };
                return answer({ status: "deny" });
            }
            return answer({ access, sessions: [live], next: null });
        });
        window.localStorage.setItem("polar.mode", "code");
        render(<Harness />, { wrapper: MessagesWrapper });
        fireEvent.click(await screen.findByRole("button", { name: /Fix the login form/ }));
        expect(await screen.findByText("The agent wants to use Bash")).toBeTruthy();
        expect(screen.getByText("rm -rf build")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Deny" }));
        await waitFor(() =>
            expect(answered).toEqual([
                { requestId: "44444444-4444-4444-8444-444444444444", choice: "deny" }
            ])
        );
        await waitFor(() => expect(screen.queryByText("The agent wants to use Bash")).toBeNull());
    });
});

describe("starting from an issue or a skill", () => {
    it("starts from an issue with nothing typed, and names the skill picked", async () => {
        access = "manage";
        vi.mocked(fetch).mockImplementation(async (url, init) => {
            const address = String(url);
            if (address.startsWith("/api/polar/code/thread")) return answer(thread);
            if (address.startsWith("/api/polar/code/choices"))
                return answer({
                    ...CHOICES,
                    skills: [{ name: "tdd", description: "Tests first" }]
                });
            if (address.startsWith("/api/polar/code/issues"))
                return answer({
                    items: [{ number: 42, title: "Login fails on Safari", labels: ["bug"] }]
                });
            if (address.startsWith("/api/polar/code/branches"))
                return answer({ defaultBranch: "main", branches: ["main"] });
            if (address.startsWith("/api/polar/code/start")) {
                started.push(JSON.parse(String(init?.body)));
                return answer({ id: "33333333-3333-4333-8333-333333333333" });
            }
            return answer({ access, sessions: [], next: null });
        });
        render(<Harness />, { wrapper: MessagesWrapper });
        const codeOption = await screen.findByRole("radio", { name: /code/i });
        await waitFor(() => expect((codeOption as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(codeOption);
        await screen.findByRole("button", { name: /^Where the agent works: acme\/web/ });
        // Nothing typed and no issue: the button is the voice one, not a send.
        expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();

        fireEvent.pointerDown(screen.getByRole("button", { name: "Issue: none" }), {
            button: 0,
            ctrlKey: false
        });
        fireEvent.click(await screen.findByRole("menuitem", { name: /Login fails on Safari/ }));
        expect(screen.getByRole("button", { name: "Issue: #42 Login fails on Safari" })).toBeTruthy();

        fireEvent.pointerDown(screen.getByRole("button", { name: "Skill: none" }), {
            button: 0,
            ctrlKey: false
        });
        fireEvent.click(await screen.findByRole("menuitem", { name: /tdd/ }));

        const send = screen.getByRole("button", { name: "Start session" }) as HTMLButtonElement;
        await waitFor(() => expect(send.disabled).toBe(false));
        fireEvent.click(send);
        await waitFor(() => expect(started).toHaveLength(1));
        expect(started[0]).toMatchObject({
            title: "#42 Login fails on Safari",
            prompt: "",
            issueNumber: 42,
            skill: "tdd"
        });
    });
});
