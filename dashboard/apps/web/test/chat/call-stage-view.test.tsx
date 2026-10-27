// @vitest-environment jsdom

/**
 * The call stage in a conversation: the buttons do what they say, the ringing
 * comes and goes with the frames, and the corner card steps aside only while
 * the stage for the same call is on screen.
 */

import { MessagesWrapper } from "../setup/i18n";
import { CallStage } from "@/app/(app)/chat/call-stage";
import { IncomingCalls } from "@/components/incoming-calls";
import { useRingingHere } from "@/app/(app)/chat/use-ringing-here";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type Handler = (frame: unknown, context: { owner: boolean }) => void;
/** Every frame handler mounted, so a call can be made to arrive at all of them. */
let frameHandlers: Handler[] = [];
/** Every peer listener mounted, like the tabs sharing one channel. */
let peers: { handler: (message: unknown) => void; posted: unknown[] }[] = [];
const sounds: string[] = [];

vi.mock("@/components/session-scope", () => ({ useSessionScope: () => "scope" }));

vi.mock("@/app/(app)/chat/call-hold", () => ({ useHeldCall: () => null }));

vi.mock("@/app/(app)/chat/use-chat-stream", async () => {
    const react = await import("react");
    return {
        useChatStream: (handler: Handler) => {
            const ref = react.useRef(handler);
            ref.current = handler;
            react.useEffect(() => {
                const call: Handler = (frame, context) => ref.current(frame, context);
                frameHandlers.push(call);
                return () => {
                    frameHandlers = frameHandlers.filter((one) => one !== call);
                };
            }, []);
        }
    };
});

vi.mock("@/lib/shared-stream", () => ({
    openPeerChannel: (_name: string, _scope: string, handler: (message: unknown) => void) => {
        const self = { handler, posted: [] as unknown[] };
        peers.push(self);
        return {
            // A broadcast reaches every other listener, never the one posting.
            post: (message: unknown) => {
                self.posted.push(message);
                for (const peer of peers) if (peer !== self) peer.handler(message);
            },
            close: () => {
                peers = peers.filter((one) => one !== self);
            }
        };
    }
}));

vi.mock("@/lib/desktop-notify", () => ({
    notifyDesktop: async () => null,
    tabIsWatched: () => true,
    mayNotify: async () => false,
    noticeStanding: () => "granted"
}));

vi.mock("@/lib/call-sounds", () => ({
    RING_FOR_MS: 30_000,
    playCallSound: (name: string) => sounds.push(name),
    startRinging: () => () => undefined,
    willBeHeard: async () => true
}));

vi.mock("@/lib/chat/call-elsewhere-request", () => ({ askCallElsewhere: async () => null }));

// Server actions the roster's menus reach, which this test never presses.
vi.mock("@/app/(app)/chat/meeting-actions", () => ({}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({ reportPersonAction: async () => ({}) }));
vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));
vi.mock("@/components/photo-access", () => ({ usePhotoOpenable: () => false }));

const ring = (meetingId: string, channelId = "c1") => ({
    kind: "call",
    state: "ringing",
    channelId,
    meetingId,
    count: 1,
    userId: "grace",
    name: "Grace"
});

const send = (frame: unknown) =>
    act(() => {
        for (const handler of frameHandlers) handler(frame, { owner: true });
    });

const people = [
    {
        id: "seat-grace",
        userId: "grace",
        name: "Grace",
        muted: false,
        deafened: false,
        streaming: false,
        serverMuted: false,
        serverDeafened: false
    },
    {
        id: "seat-bo",
        userId: "bo",
        name: "Bo Diaz",
        muted: true,
        deafened: false,
        streaming: false,
        serverMuted: false,
        serverDeafened: false
    }
];

beforeEach(() => {
    frameHandlers = [];
    peers = [];
    sounds.length = 0;
});

afterEach(() => cleanup());

function stage(over: Partial<Parameters<typeof CallStage>[0]> = {}) {
    const props = {
        meetingId: "m1",
        people,
        count: 2,
        caller: null,
        canJoin: true,
        onJoin: vi.fn(),
        onDecline: vi.fn(),
        onHide: vi.fn(),
        ...over
    };
    render(<CallStage {...props} />, { wrapper: MessagesWrapper });
    return props;
}

describe("the call stage", () => {
    it("while ringing: pulses the caller and offers video, voice and decline", () => {
        const props = stage({ caller: { id: "grace", name: "Grace" } });

        expect(screen.getByRole("region", { name: "Incoming call" })).toBeTruthy();
        expect(screen.getByText("Grace is calling")).toBeTruthy();
        expect(screen.getAllByTestId("ring-pulse")).toHaveLength(1);
        // The muted mark comes from the roster.
        expect(screen.getByLabelText("Microphone off")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Join with video" }));
        expect(props.onJoin).toHaveBeenLastCalledWith(true);
        fireEvent.click(screen.getByRole("button", { name: "Join" }));
        expect(props.onJoin).toHaveBeenLastCalledWith(false);
        fireEvent.click(screen.getByRole("button", { name: "Decline" }));
        expect(props.onDecline).toHaveBeenCalledTimes(1);
    });

    it("draws the caller from the ring before the roster has them", () => {
        stage({ people: [], count: 1, caller: { id: "grace", name: "Grace" } });
        expect(screen.getAllByTestId("ring-pulse")).toHaveLength(1);
        expect(screen.getAllByText("Grace").length).toBeGreaterThan(0);
    });

    it("in progress: no ringing and no decline, only the ways in", () => {
        stage();
        expect(screen.getByRole("region", { name: "Call in progress" })).toBeTruthy();
        expect(screen.getByText("2 people in the call")).toBeTruthy();
        expect(screen.queryByTestId("ring-pulse")).toBeNull();
        expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
        expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
    });

    it("offers no way in to somebody who cannot join", () => {
        stage({ canJoin: false, caller: { id: "grace", name: "Grace" } });
        expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Join with video" })).toBeNull();
        expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    });

    it("can be put away", () => {
        const props = stage();
        fireEvent.click(screen.getByRole("button", { name: "Hide the call" }));
        expect(props.onHide).toHaveBeenCalledTimes(1);
    });
});

function Ringing({ channelId = "c1" }: { channelId?: string }) {
    const { ring, decline, silenced, silence } = useRingingHere(channelId, "ada", null);
    return (
        <div>
            <span data-testid="ring">{ring ? ring.meetingId : "none"}</span>
            <span data-testid="silenced">{silenced ? "yes" : "no"}</span>
            <button type="button" onClick={decline}>
                decline here
            </button>
            <button type="button" onClick={silence}>
                silence here
            </button>
        </div>
    );
}

describe("ringing in the conversation", () => {
    it("rings for this conversation only, and stops when the call ends", () => {
        render(<Ringing />);
        send(ring("m9", "c2"));
        expect(screen.getByTestId("ring").textContent).toBe("none");
        send(ring("m1"));
        expect(screen.getByTestId("ring").textContent).toBe("m1");
        send({ ...ring("m1"), state: "ended", count: 0 });
        expect(screen.getByTestId("ring").textContent).toBe("none");
    });

    it("declining stops the corner card too, with the hang-up sound", async () => {
        render(
            <>
                <Ringing />
                <IncomingCalls viewerId="ada" />
            </>,
            { wrapper: MessagesWrapper }
        );
        send(ring("m1"));
        expect(await screen.findByText("Grace is calling")).toBeTruthy();

        fireEvent.click(screen.getByText("decline here"));

        expect(screen.getByTestId("ring").textContent).toBe("none");
        expect(sounds).toEqual(["hangUp"]);
        await vi.waitFor(() => expect(screen.queryByText("Grace is calling")).toBeNull());
    });

    it("stops when the corner card settles it", async () => {
        render(
            <>
                <Ringing />
                <IncomingCalls viewerId="ada" />
            </>,
            { wrapper: MessagesWrapper }
        );
        send(ring("m1"));
        fireEvent.click(await screen.findByLabelText("Decline"));
        expect(screen.getByTestId("ring").textContent).toBe("none");
    });
});

describe("a conversation opened after the ring arrived", () => {
    it("rings from what the corner card is still ringing about", async () => {
        const view = render(<IncomingCalls viewerId="ada" />, { wrapper: MessagesWrapper });
        send(ring("m1"));
        expect(await screen.findByText("Grace is calling")).toBeTruthy();

        // Opened now, from the notice: the frame has already gone by.
        view.rerender(
            <>
                <IncomingCalls viewerId="ada" />
                <Ringing />
            </>
        );
        expect(screen.getByTestId("ring").textContent).toBe("m1");

        // Not for another conversation.
        view.rerender(
            <>
                <IncomingCalls viewerId="ada" />
                <Ringing channelId="c2" />
            </>
        );
        expect(screen.getByTestId("ring").textContent).toBe("none");
    });

    it("declining it stops the card", async () => {
        const view = render(<IncomingCalls viewerId="ada" />, { wrapper: MessagesWrapper });
        send(ring("m1"));
        await screen.findByText("Grace is calling");
        view.rerender(
            <>
                <IncomingCalls viewerId="ada" />
                <Ringing />
            </>
        );

        fireEvent.click(screen.getByText("decline here"));

        await vi.waitFor(() => expect(screen.queryByText("Grace is calling")).toBeNull());
        expect(screen.getByTestId("ring").textContent).toBe("none");
    });

    it("silencing it silences the card, and the call keeps ringing on screen", async () => {
        const view = render(<IncomingCalls viewerId="ada" />, { wrapper: MessagesWrapper });
        send(ring("m1"));
        await screen.findByText("Grace is calling");
        view.rerender(
            <>
                <IncomingCalls viewerId="ada" />
                <Ringing />
            </>
        );
        expect(screen.getByTestId("silenced").textContent).toBe("no");

        fireEvent.click(screen.getByText("silence here"));

        await vi.waitFor(() => expect(screen.getByTestId("silenced").textContent).toBe("yes"));
        expect((screen.getByLabelText("Silence the ring") as HTMLButtonElement).disabled).toBe(
            true
        );
        expect(screen.getByTestId("ring").textContent).toBe("m1");
    });
});

describe("the stage's silence button", () => {
    it("shows only while ringing, and is spent once silenced", () => {
        const onSilence = vi.fn();
        stage({ caller: { id: "grace", name: "Grace" }, onSilence });
        fireEvent.click(screen.getByRole("button", { name: "Silence the ring" }));
        expect(onSilence).toHaveBeenCalledTimes(1);
        cleanup();

        stage({ caller: { id: "grace", name: "Grace" }, onSilence, silenced: true });
        expect(
            (screen.getByRole("button", { name: "Silence the ring" }) as HTMLButtonElement).disabled
        ).toBe(true);
        cleanup();

        stage({ onSilence });
        expect(screen.queryByRole("button", { name: "Silence the ring" })).toBeNull();
    });
});

describe("the corner card beside a stage", () => {
    it("steps aside while the stage for the same call is on screen, and only then", async () => {
        const view = render(<IncomingCalls viewerId="ada" />, { wrapper: MessagesWrapper });
        send(ring("m1"));
        expect(await screen.findByText("Grace is calling")).toBeTruthy();

        // A stage for another call changes nothing.
        view.rerender(
            <>
                <IncomingCalls viewerId="ada" />
                <CallStage
                    meetingId="m2"
                    people={people}
                    count={2}
                    caller={null}
                    canJoin
                    onJoin={() => undefined}
                    onDecline={() => undefined}
                    onHide={() => undefined}
                />
            </>
        );
        expect(screen.getByText("Grace is calling")).toBeTruthy();

        view.rerender(
            <>
                <IncomingCalls viewerId="ada" />
                <CallStage
                    meetingId="m1"
                    people={people}
                    count={2}
                    caller={{ id: "grace", name: "Grace" }}
                    canJoin
                    onJoin={() => undefined}
                    onDecline={() => undefined}
                    onHide={() => undefined}
                />
            </>
        );
        // The stage's own heading says who is calling; the card is gone.
        expect(screen.queryByRole("alert")).toBeNull();

        view.rerender(<IncomingCalls viewerId="ada" />);
        expect(await screen.findByRole("alert")).toBeTruthy();
    });
});
