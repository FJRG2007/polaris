// @vitest-environment jsdom
/**
 * A Polar Code message's row offers what Chat's does: send again and save as a
 * command on the person's message; rate, read aloud and answer again on the
 * agent's. An action the thread did not hand over is not drawn, and marks on a
 * Code answer name the session's message. Fixture data throughout.
 */

import type { ReactNode } from "react";
import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import type { PolarCodeEntry } from "@/lib/polar/code";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    usePathname: () => "/polar",
    useRouter: () => ({ push: () => undefined })
}));
vi.mock("next/link", () => ({
    default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>
}));

const { CodeMessage, codeRetryOf } = await import("@/components/polar/polar-code");
const { useAnswerMarks } = await import("@/components/polar/polar-answer-actions");

const ASK: PolarCodeEntry = {
    id: "11111111-1111-4111-8111-111111111111",
    at: "2026-10-20T10:00:01.000Z",
    type: "message",
    role: "user",
    text: "Fix the login form",
    detail: ""
};
const ANSWER: PolarCodeEntry = {
    id: "22222222-2222-4222-8222-222222222222",
    at: "2026-10-20T10:00:05.000Z",
    type: "message",
    role: "agent",
    text: "Fixed. The form now checks the email first.",
    detail: ""
};

const calls: Array<{ url: string; method: string; body: unknown }> = [];

class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onpause: (() => void) | null = null;
    async play() {
        queueMicrotask(() => this.onended?.());
    }
    pause() {
        this.onpause?.();
    }
}

function wrap(children: ReactNode) {
    return render(
        <MessagesWrapper>
            <ToastProvider>{children}</ToastProvider>
        </MessagesWrapper>
    );
}

beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("Audio", FakeAudio);
    URL.createObjectURL = () => "blob:x";
    URL.revokeObjectURL = () => undefined;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            const method = init?.method ?? "GET";
            calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
            if (url.startsWith("/api/polar/feedback?")) return Response.json({ marks: {} });
            if (url === "/api/polar/feedback") return Response.json({ mark: {} });
            if (url === "/api/polar/speak") return new Response("a");
            return Response.json({});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the person's message", () => {
    it("sends again, saves as a command and edits into the composer", () => {
        const onResend = vi.fn();
        const onSaveCommand = vi.fn();
        const onCompose = vi.fn();
        wrap(
            <CodeMessage
                entry={ASK}
                actions={{ onCompose, onResend, onSaveCommand, speech: true, payer: null }}
            />
        );
        fireEvent.click(screen.getByLabelText("Send again"));
        fireEvent.click(screen.getByLabelText("Save as command"));
        fireEvent.click(screen.getByLabelText("Edit message"));
        expect(onResend).toHaveBeenCalledOnce();
        expect(onSaveCommand).toHaveBeenCalledOnce();
        expect(onCompose).toHaveBeenCalledWith("Fix the login form");
        // An agent's actions are not on the person's message.
        expect(screen.queryByLabelText("Read aloud")).toBeNull();
        expect(screen.queryByLabelText("Rate response")).toBeNull();
    });

    it("draws no send again where the thread offers none", () => {
        wrap(<CodeMessage entry={ASK} actions={{ onCompose: vi.fn(), speech: false, payer: null }} />);
        expect(screen.queryByLabelText("Send again")).toBeNull();
        expect(screen.queryByLabelText("Save as command")).toBeNull();
    });
});

describe("the agent's answer", () => {
    it("answers again, and reads aloud only with a voice to read it", async () => {
        const onRegenerate = vi.fn();
        const view = wrap(
            <CodeMessage
                entry={ANSWER}
                actions={{ onCompose: vi.fn(), onRegenerate, speech: true, payer: "own" }}
            />
        );
        fireEvent.click(screen.getByLabelText("Answer again"));
        expect(onRegenerate).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByLabelText("Read aloud"));
        await waitFor(() => expect(calls.some((call) => call.url === "/api/polar/speak")).toBe(true));
        expect(calls.find((call) => call.url === "/api/polar/speak")?.body).toMatchObject({ payer: "own" });
        view.unmount();
        wrap(<CodeMessage entry={ANSWER} actions={{ onCompose: vi.fn(), speech: false, payer: null }} />);
        expect(screen.queryByLabelText("Read aloud")).toBeNull();
        expect(screen.queryByLabelText("Answer again")).toBeNull();
    });

    it("marks the session's message, by its id", async () => {
        function Marked() {
            const marks = useAnswerMarks({ session: "33333333-3333-4333-8333-333333333333" });
            return (
                <CodeMessage
                    entry={ANSWER}
                    actions={{
                        onCompose: vi.fn(),
                        speech: false,
                        payer: null,
                        mark: marks.marks[ANSWER.id] ?? null,
                        onMark: (change) => marks.mark(ANSWER.id, change)
                    }}
                />
            );
        }
        wrap(<Marked />);
        const trigger = screen.getByLabelText("Rate response");
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
        fireEvent.click(await screen.findByRole("menuitem", { name: "Good response" }));
        await waitFor(() =>
            expect(calls.filter((call) => call.method === "PUT")[0]?.body).toEqual({
                sessionMessageId: ANSWER.id,
                rating: "good",
                reasons: [],
                note: null
            })
        );
        expect(calls[0]?.url).toBe("/api/polar/feedback?session=33333333-3333-4333-8333-333333333333");
    });
});

describe("codeRetryOf", () => {
    const line = (role: string, at: string, type: "message" | "event" = "message"): PolarCodeEntry => ({
        id: `${role}-${at}`,
        at,
        type,
        role,
        text: role,
        detail: ""
    });

    it("is the last message and the answer after it, past Polaris's own lines and steps", () => {
        const ask = line("user", "2");
        const answer = line("agent", "4");
        expect(
            codeRetryOf([line("user", "1"), line("agent", "1b"), ask, line("tool.start", "3", "event"), answer, line("system", "5")])
        ).toEqual({ ask, answer });
    });

    it("has no answer while the last message waits for one, and nothing in an empty thread", () => {
        const ask = line("user", "2");
        expect(codeRetryOf([line("agent", "1"), ask])).toEqual({ ask, answer: null });
        expect(codeRetryOf([])).toEqual({ ask: null, answer: null });
    });
});
