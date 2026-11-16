// @vitest-environment jsdom
/**
 * What a Code call says, and when: a reply of a session not on screen is read
 * with its title first, and nothing is handed to the call until it is quiet,
 * one thing at a time, so two replies never talk over each other.
 *
 * Chat's `VoiceCall` is replaced by a probe that records what it is handed and
 * lets the test say when the call is quiet.
 */

import type { UIMessage } from "ai";
import { MessagesWrapper } from "../setup/i18n";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SENT = "2026-11-16T10:00:30.000Z";

const probe = {
    messages: [] as UIMessage[],
    announced: null as string | null,
    onSend: null as null | ((text: string) => void),
    onQuiet: null as null | ((quiet: boolean) => void)
};

vi.mock("@/components/polar/polar-voice", () => ({
    VoiceCall: (props: {
        messages: UIMessage[];
        announced: string | null;
        onSend: (text: string) => void;
        onQuiet: (quiet: boolean) => void;
    }) => {
        probe.messages = props.messages;
        probe.announced = props.announced;
        probe.onSend = props.onSend;
        probe.onQuiet = props.onQuiet;
        return null;
    }
}));

const { CodeVoiceCall } = await import("@/components/polar/code-voice-call");

const KIT = {
    voice: { dictation: true, speech: false, transcribers: [], transcriber: null },
    payer: null,
    onTranscriber: () => undefined,
    isAdmin: false
};

function otherThread(text: string) {
    return {
        session: {
            id: B,
            title: "Fix the login form",
            repo: "acme/web",
            branch: "main",
            state: "idle",
            stateLabel: "Waiting for you",
            live: true,
            createdAt: "2026-11-16T10:00:00.000Z"
        },
        entries: [{ at: "2026-11-16T10:01:00.000Z", type: "message", role: "assistant", text, detail: "" }],
        error: null,
        permission: null
    };
}

function said(id: string | null): string | undefined {
    const message = probe.messages.find((entry) => entry.id === id);
    return message?.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

beforeEach(() => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url === "/api/polar/voice/delegate")
                return Response.json({ say: "Sent.", open: null, sent: [{ sessionId: B, at: SENT }], explained: {} });
            if (url.startsWith("/api/polar/code/thread"))
                return Response.json({ value: otherThread("The form takes the code now.\n\nDetails.") });
            return Response.json({});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the Code call's announcements", () => {
    it("names another session before its reply, and waits for a quiet call", async () => {
        render(
            <CodeVoiceCall
                sessionId={A}
                thread={null}
                kit={KIT}
                greeting={null}
                onOpen={() => undefined}
                onEnd={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        // Speaking: the delegator's answer is not handed over yet.
        act(() => probe.onQuiet!(false));
        act(() => probe.onSend!("fix the login form"));
        await waitFor(() => expect(probe.messages.map((m) => m.role)).toEqual(["user", "assistant"]));
        expect(said(probe.messages[1]!.id)).toBe("Sent.");

        // The reply lands while the call is busy: held back, not on screen yet.
        await waitFor(
            () =>
                expect(
                    vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("/api/polar/code/thread"))
                ).toBe(true),
            { timeout: 6000 }
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(probe.messages).toHaveLength(2);
        expect(probe.announced).toBeNull();

        // Quiet: it is handed over once, with the session named first.
        act(() => probe.onQuiet!(true));
        await waitFor(() => expect(probe.announced).not.toBeNull());
        expect(said(probe.announced)).toBe("From Fix the login form: The form takes the code now.");
        expect(probe.messages).toHaveLength(3);
        // Read once: the watch is settled, so no second copy follows.
        await new Promise((resolve) => setTimeout(resolve, 4500));
        expect(probe.messages).toHaveLength(3);
    }, 15_000);
});
