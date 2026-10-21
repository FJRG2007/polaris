// @vitest-environment jsdom
/**
 * The Chat / Code switch: Code is switched off, with the reason, for an account
 * that cannot open Agents; a reader follows sessions without starting one; and
 * sending a task starts it through Polar's Code start route.
 */

import type { ReactNode } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const started: unknown[] = [];

const CHOICES = {
    sharedWorkspace: false,
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
            account: null,
            mine: null,
            machine: false,
            missing: []
        }
    ]
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

const { PolarCode, PolarModeSwitch, titleFromPrompt, usePolarCode } =
    await import("@/components/polar/polar-code");

let access: "none" | "read" | "manage" = "none";
let thread: unknown = null;

function Harness() {
    const code = usePolarCode();
    return (
        <>
            <PolarModeSwitch code={code} />
            {code.mode === "code" ? <PolarCode code={code} split={false} /> : <p>chat-view</p>}
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
            return answer({ access, sessions: [] });
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
        await screen.findByRole("combobox", { name: "Repository" });
        fireEvent.change(box, { target: { value: "Fix the login form\nwith tests" } });
        const send = screen.getByRole("button", { name: "Start session" });
        await waitFor(() => expect(send.getAttribute("aria-disabled")).toBe("false"));
        fireEvent.click(send);
        await waitFor(() => expect(started).toHaveLength(1));
        expect(started[0]).toMatchObject({
            repoId: "22222222-2222-4222-8222-222222222222",
            title: "Fix the login form",
            cli: "claude",
            prompt: "Fix the login form\nwith tests",
            enigma: { enabled: true }
        });
        // The new session opens in the thread.
        expect(await screen.findByRole("button", { name: "All sessions" })).toBeTruthy();
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
            return answer({ access, sessions: [row] });
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
            return answer({ access, sessions: [row] });
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
