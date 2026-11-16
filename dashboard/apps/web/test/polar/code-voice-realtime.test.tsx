// @vitest-environment jsdom
/**
 * Realtime voice inside a Code call: offered only to a person with an OpenAI
 * key of their own, switched on from inside the call (the standard call stays
 * the default), and shown from the link's state with a way back.
 *
 * Chat's `VoiceCall` and the WebRTC link are replaced by stand-ins.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeLink, RealtimeSnapshot } from "@/lib/polar/realtime-link";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

vi.mock("@/components/polar/polar-voice", () => ({ VoiceCall: () => <div data-testid="standard-call" /> }));
vi.mock("@/components/polar/voice-orb", () => ({ VoiceOrb: () => null }));

function fakeLink(initial: Partial<RealtimeSnapshot> = {}) {
    let state: RealtimeSnapshot = { phase: "connecting", muted: false, busy: false, caption: null, error: null, ...initial };
    const listeners = new Set<() => void>();
    const link: RealtimeLink & { push: (next: Partial<RealtimeSnapshot>) => void } = {
        snapshot: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        bind: vi.fn(),
        setMuted: vi.fn(),
        level: () => 0,
        close: vi.fn(),
        push: (next) => {
            state = { ...state, ...next };
            for (const listener of listeners) listener();
        }
    };
    return link;
}

const opened = { link: null as ReturnType<typeof fakeLink> | null, start: null as unknown };
vi.mock("@/lib/polar/realtime-link", () => ({
    openRealtimeLink: (start: unknown) => {
        opened.start = start;
        opened.link = fakeLink();
        return opened.link;
    }
}));

const { CodeVoiceCall } = await import("@/components/polar/code-voice-call");

function kit(realtime: boolean) {
    return {
        voice: { dictation: true, speech: true, transcribers: [], transcriber: null, realtime },
        payer: null,
        onTranscriber: () => undefined,
        isAdmin: false
    };
}

afterEach(() => {
    cleanup();
    opened.link = null;
});

describe("realtime voice in a Code call", () => {
    it("is not offered without an OpenAI key of the person's own", () => {
        render(
            <CodeVoiceCall
                sessionId={A}
                thread={null}
                kit={kit(false)}
                greeting={null}
                onRealtime={() => undefined}
                onOpen={() => undefined}
                onEnd={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByTestId("standard-call")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Realtime voice" })).toBeNull();
    });

    it("starts standard, switches on from inside the call, and goes back", () => {
        const onRealtime = vi.fn();
        const view = render(
            <CodeVoiceCall
                sessionId={A}
                thread={null}
                kit={kit(true)}
                greeting={null}
                onRealtime={onRealtime}
                onOpen={() => undefined}
                onEnd={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByTestId("standard-call")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Realtime voice" }));
        expect(onRealtime).toHaveBeenCalledWith(opened.link);
        expect(opened.start).toMatchObject({ binding: { sessionId: A }, lang: "en-US" });

        const link = opened.link!;
        view.rerender(
            <CodeVoiceCall
                sessionId={A}
                thread={null}
                kit={kit(true)}
                greeting={null}
                realtime={link}
                onRealtime={onRealtime}
                onOpen={() => undefined}
                onEnd={() => undefined}
            />
        );
        expect(screen.queryByTestId("standard-call")).toBeNull();
        expect(screen.getByText("Connecting")).toBeTruthy();
        expect(link.bind).toHaveBeenCalledWith(expect.objectContaining({ sessionId: A }));

        act(() => link.push({ phase: "live", caption: "Sent that to Login." }));
        expect(screen.getByText("Listening")).toBeTruthy();
        expect(screen.getByText("Sent that to Login.")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
        expect(link.setMuted).toHaveBeenCalledWith(true);

        fireEvent.click(screen.getByRole("button", { name: "Standard voice" }));
        expect(onRealtime).toHaveBeenLastCalledWith(null);
    });

    it("says what is missing when the call cannot open", () => {
        const link = fakeLink({ phase: "failed", error: "no_key" });
        render(
            <CodeVoiceCall
                sessionId={A}
                thread={null}
                kit={kit(true)}
                greeting={null}
                realtime={link}
                onRealtime={() => undefined}
                onOpen={() => undefined}
                onEnd={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByRole("alert").textContent).toBe("Realtime voice needs an OpenAI key of your own.");
        expect(screen.getByRole("button", { name: "Standard voice" })).toBeTruthy();
    });
});
