// @vitest-environment jsdom
/**
 * Watching somebody's stream in a direct message, and what right-clicking it
 * offers.
 *
 * In a direct message a share is watched as it starts and fills the call, the
 * people in a row under it; asked for by name it has the call to itself, and
 * somebody who stops watching it is not made to watch it again in that call.
 * The buttons over it come with the pointer and go when it rests. Right-clicking
 * the stream mutes it, sets its volume, pops it out and sets how far voices are
 * lowered while it plays; right-clicking a person in a call of two shows
 * combining greyed out.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { CallState } from "@/app/(app)/chat/call-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { REVEAL_IDLE_MS } from "@/app/(app)/chat/call-tile-controls";
import {
    rememberStopped,
    setWatchedStreams,
    streamMuted,
    voiceScale,
    watchedStreams
} from "@/app/(app)/chat/call-stream-audio";

vi.mock("@/app/(app)/chat/soundboard-actions", () => ({
    favoriteSoundAction: async () => ({}),
    playSoundAction: async () => ({})
}));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({ admitAction: async () => ({}) }));
vi.mock("@/app/(app)/chat/call-activity-actions", () => ({
    callGames: async () => ({ ok: false, reason: "missing" }),
    vouchCallGames: async () => ({ seats: [], now: Date.now() })
}));
vi.mock("@/app/(app)/chat/actions", () => ({ searchPeopleAction: async () => ({ people: [] }) }));
vi.mock("@/app/(app)/chat/call-session", () => ({ useHeldCall: () => null }));
vi.mock("@/app/(app)/chat/speaker-device", () => ({
    useSpeakers: () => ({ devices: [], chosenId: null, choose: () => undefined })
}));
vi.mock("@/lib/call-sounds", () => ({ playCallSound: () => undefined }));
vi.mock("@/components/avatar", () => ({ Avatar: () => <span /> }));
vi.mock("@/components/people-picker", () => ({ PeoplePicker: () => null }));

const { CallRoom } = await import("@/app/(app)/chat/call-room");
const { PersonMenu } = await import("@/app/(app)/chat/call-menus");

const video = {
    kind: "video",
    readyState: "live",
    muted: false,
    addEventListener() {},
    removeEventListener() {}
};

class FakeStream {
    constructor(
        private readonly audio: number,
        private readonly picture: object = video
    ) {}
    getAudioTracks() {
        return Array.from({ length: this.audio }, () => ({ kind: "audio" }));
    }
    getVideoTracks() {
        return [this.picture];
    }
    getTracks() {
        return [...this.getAudioTracks(), ...this.getVideoTracks()];
    }
    addEventListener() {}
    removeEventListener() {}
}

function call(over: Partial<CallState> = {}): CallState {
    return {
        meeting: {
            hostId: "ana",
            guestToken: null,
            participants: [
                { id: "seat-ana", userId: "ana", name: "Ana", admission: "admitted" },
                { id: "seat-bo", userId: "bo", name: "Bo", admission: "admitted" }
            ]
        },
        participantId: "seat-ana",
        localStream: null,
        localScreen: null,
        remote: new Map(),
        screens: new Map([["seat-bo", new FakeStream(1) as unknown as MediaStream]]),
        speaking: new Set(),
        states: new Map(),
        micOn: true,
        cameraOn: false,
        sharing: false,
        deafened: false,
        moderation: { serverMuted: false, serverDeafened: false },
        ended: false,
        error: "",
        microphones: [],
        cameras: [],
        reactions: [],
        hands: [],
        handRaised: false,
        nearby: new Set(),
        audioRole: null,
        audioMembers: [],
        combineOpen: false,
        combineAsked: null,
        combineRequest: null,
        recording: false,
        audio: { state: "fine" },
        outgoing: null,
        cameraQuality: "auto",
        screenQuality: "auto",
        cameraLevel: "high",
        screenLevel: "high",
        setActivity: () => undefined,
        sendActivity: () => undefined,
        listenActivity: () => () => undefined,
        ...over
    } as unknown as CallState;
}

/** Node's own `localStorage` shadows the page's and is off without a file. */
const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
        clear: () => stored.clear()
    }
});

beforeEach(() => {
    window.localStorage.clear();
    setWatchedStreams([]);
    rememberStopped("m1", []);
    rememberStopped("m2", []);
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
        configurable: true,
        value: () => Promise.resolve()
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error: "Not in this call." }, { status: 410 }))
    );
});

afterEach(cleanup);

/** The tile a stream is drawn in. */
const streamTile = () =>
    document.querySelector("video")!.closest("[class*='group/tile']") as HTMLElement;

describe("a stream in a direct message", () => {
    it("is watched as soon as it starts, filling the call with the people under it", () => {
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        expect(watchedStreams()).toEqual(["screen:seat-bo"]);
        expect(screen.queryByTitle("Watch Bo - screen")).toBeNull();
        const stream = document.querySelector("video")!;
        const you = screen.getByText("You");
        // After the stream in the document, which in a column is under it.
        expect(stream.compareDocumentPosition(you) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(stream.closest(".grid")).not.toBe(you.closest(".grid"));
        expect(screen.getByText("Bo")).toBeTruthy();
    });

    it("watches a share that starts later as well", () => {
        const { rerender } = render(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call({ screens: new Map() })}
                onLeave={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(watchedStreams()).toEqual([]);
        rerender(
            <CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />
        );
        expect(watchedStreams()).toEqual(["screen:seat-bo"]);
    });

    it("goes straight up in a voice room, as it always did", () => {
        render(<CallRoom meetingId="m1" place="room" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        expect(watchedStreams()).toEqual(["screen:seat-bo"]);
    });

    it("stays stopped in this call once somebody stops watching it", () => {
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: "Stop watching Bo - screen" }));
        expect(watchedStreams()).toEqual([]);
        expect(screen.getByTitle("Watch Bo - screen")).toBeTruthy();

        // The conversation closed and opened again: still stopped.
        cleanup();
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        expect(watchedStreams()).toEqual([]);
        expect(screen.getByTitle("Watch Bo - screen")).toBeTruthy();

        // Another call is another decision.
        cleanup();
        render(<CallRoom meetingId="m2" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        expect(watchedStreams()).toEqual(["screen:seat-bo"]);
    });

    it("is watched again once its share ends and starts over", () => {
        const { rerender } = render(
            <CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Stop watching Bo - screen" }));
        rerender(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call({ screens: new Map() })}
                onLeave={() => undefined}
            />
        );
        rerender(
            <CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />
        );
        expect(watchedStreams()).toEqual(["screen:seat-bo"]);
    });

    it("is watched again when the share started over while the call was closed", () => {
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: "Stop watching Bo - screen" }));
        expect(watchedStreams()).toEqual([]);

        cleanup();
        const again = new FakeStream(1, { ...video, id: "second-share" });
        render(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call({ screens: new Map([["seat-bo", again as unknown as MediaStream]]) })}
                onLeave={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(watchedStreams()).toEqual(["screen:seat-bo"]);
    });

    it("takes the call alone when asked, and gives the people back", () => {
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: "Make this bigger" }));
        expect(screen.queryByText("You")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Back to the people" }));
        expect(screen.getByText("You")).toBeTruthy();
        expect(watchedStreams()).toEqual(["screen:seat-bo"]);
    });

    it("leaves the speaking ring room in the strip of faces under a stream", () => {
        // The report: with a screen shared, a talking person's green ring was cut
        // off top and bottom - the strip scrolls sideways, which clips the other
        // way too, and the ring is drawn outside the tile.
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={vi.fn()} />, {
            wrapper: MessagesWrapper
        });
        const strip = screen.getByText("You").closest(".grid") as HTMLElement;
        expect(strip.className).toContain("overflow-x-auto");
        // As much room inside its edges as the ring is wide (ring-2: 2px).
        expect(strip.className.split(" ")).toEqual(expect.arrayContaining(["p-0.5"]));
    });

    it("says it is live on its tile, with a screen beside its name", () => {
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        expect(within(streamTile()).getAllByText("Live").length).toBeGreaterThan(0);
    });

    it("offers expanding the call, and says which way it goes", () => {
        const onExpand = vi.fn();
        const { rerender } = render(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call()}
                onExpand={onExpand}
                onLeave={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Expand the call" }));
        expect(onExpand).toHaveBeenLastCalledWith(true);
        rerender(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call()}
                expanded
                onExpand={onExpand}
                onLeave={() => undefined}
            />
        );
        fireEvent.click(screen.getByRole("button", { name: "Shrink the call" }));
        expect(onExpand).toHaveBeenLastCalledWith(false);
    });

    it("marks somebody sharing a screen as live", () => {
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        const bo = screen.getByText("Bo").closest("[class*='group/tile']") as HTMLElement;
        expect(within(bo).getAllByRole("img", { name: "Sharing a screen" })).toHaveLength(1);
    });

    it("offers mute, volume, pop-out and attenuation on right-click", () => {
        Object.defineProperty(document, "pictureInPictureEnabled", {
            configurable: true,
            value: true
        });
        Object.defineProperty(HTMLVideoElement.prototype, "requestPictureInPicture", {
            configurable: true,
            value: () => Promise.resolve({})
        });
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.contextMenu(streamTile());
        const menu = screen.getByRole("menu");
        expect(within(menu).getByRole("menuitem", { name: /Pop out/ })).toBeTruthy();
        expect(within(menu).getByLabelText("How loud Bo - screen is")).toBeTruthy();
        const attenuation = screen.getByLabelText(
            "How far other voices are lowered while a stream plays"
        ) as HTMLInputElement;
        expect(attenuation.value).toBe("30");
        fireEvent.change(attenuation, { target: { value: "60" } });
        expect(JSON.parse(window.localStorage.getItem("polaris.voice.settings")!)).toMatchObject({
            streamAttenuation: 60
        });

        const mute = screen.getByRole("menuitemcheckbox", { name: /Mute stream/ });
        act(() => fireEvent.click(mute));
        expect(streamMuted("bo")).toBe(true);
    });

    it("says a stream with no sound has none", () => {
        render(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call({
                    screens: new Map([["seat-bo", new FakeStream(0) as unknown as MediaStream]])
                })}
                onLeave={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.contextMenu(streamTile());
        expect(
            within(screen.getByRole("menu")).getByText("This stream has no sound.")
        ).toBeTruthy();
    });
});

describe("the buttons over a stream", () => {
    afterEach(() => vi.useRealTimers());

    it("come with the pointer and go again once it rests", () => {
        vi.useFakeTimers();
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        const full = within(streamTile()).getByRole("button", { name: "Full screen" });
        const box = full.closest("[data-tile-controls]") as HTMLElement;
        expect(box.className).toContain("opacity-0");
        fireEvent.pointerMove(streamTile());
        expect(box.className).toContain("opacity-100");
        act(() => vi.advanceTimersByTime(REVEAL_IDLE_MS + 10));
        expect(box.className).toContain("opacity-0");
        expect(box.className).toContain("pointer-events-none");
    });

    it("stay up while a key is on one of them", () => {
        vi.useFakeTimers();
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        const full = within(streamTile()).getByRole("button", { name: "Full screen" });
        const box = full.closest("[data-tile-controls]") as HTMLElement;
        act(() => full.focus());
        act(() => vi.advanceTimersByTime(REVEAL_IDLE_MS * 2));
        expect(box.className).toContain("opacity-100");
    });

    it("carry the stream's volume, its window, zoom and full screen", () => {
        Object.defineProperty(document, "pictureInPictureEnabled", {
            configurable: true,
            value: true
        });
        Object.defineProperty(HTMLVideoElement.prototype, "requestPictureInPicture", {
            configurable: true,
            value: () => Promise.resolve({})
        });
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        const tile = within(streamTile());
        const slider = tile.getByLabelText("How loud Bo - screen is") as HTMLInputElement;
        fireEvent.change(slider, { target: { value: "0.5" } });
        expect(slider.value).toBe("0.5");
        act(() => fireEvent.click(tile.getByRole("button", { name: "Mute stream" })));
        expect(streamMuted("bo")).toBe(true);
        expect(tile.getByRole("button", { name: "Unmute stream" })).toBeTruthy();
        expect(tile.getByRole("button", { name: "Pop out" })).toBeTruthy();
        expect(tile.getByRole("button", { name: "Zoom in" })).toBeTruthy();
        expect(tile.getByRole("button", { name: "Full screen" })).toBeTruthy();
    });

    it("are pressed, not dragged, on a zoomed picture", () => {
        const capture = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
            configurable: true,
            value: capture
        });
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        const tile = within(streamTile());
        fireEvent.click(tile.getByRole("button", { name: "Zoom in" }));
        fireEvent.pointerDown(tile.getByRole("button", { name: "Full screen" }), {
            button: 0,
            pointerId: 1
        });
        fireEvent.pointerDown(tile.getByLabelText("How loud Bo - screen is"), {
            button: 0,
            pointerId: 1
        });
        expect(capture).not.toHaveBeenCalled();
        fireEvent.pointerDown(document.querySelector("video")!, { button: 0, pointerId: 1 });
        expect(capture).toHaveBeenCalledTimes(1);
    });

    it("goes full screen on a double press", () => {
        const requestFullscreen = vi.fn(() => Promise.resolve());
        Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
            configurable: true,
            value: requestFullscreen
        });
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.doubleClick(document.querySelector("video")!);
        expect(requestFullscreen).toHaveBeenCalledTimes(1);
        // Not from a button, which is a button being pressed twice.
        fireEvent.doubleClick(within(streamTile()).getByRole("button", { name: "Zoom in" }));
        expect(requestFullscreen).toHaveBeenCalledTimes(1);
    });
});

describe("the three sizes a watched stream has", () => {
    it("offers the column between the call and the whole display", () => {
        // The defect this pins down: from the picture itself there were two sizes,
        // the room the call gave it and the whole display. Somebody trying to read
        // a shared screen had nothing in between - the step that puts the
        // conversation away and gives the call the column lived in a chevron at the
        // top of the panel, which is not where they were looking.
        const onExpand = vi.fn();
        const { rerender } = render(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call()}
                onExpand={onExpand}
                onLeave={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Fill the column" }));
        expect(onExpand).toHaveBeenLastCalledWith(true);

        rerender(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call()}
                expanded
                onExpand={onExpand}
                onLeave={() => undefined}
            />
        );
        const back = screen.getByRole("button", { name: "Bring the conversation back" });
        expect(back.getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(back);
        expect(onExpand).toHaveBeenLastCalledWith(false);
    });

    it("says nothing about a column in a voice room, which is one already", () => {
        render(<CallRoom meetingId="m1" place="room" call={call()} onLeave={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Fill the column" })).toBeNull();
    });
});

describe("combining from a person's menu", () => {
    const menu = (locked: boolean) => (
        <PersonMenu
            name="Bo"
            volumeKey="bo"
            onCombine={() => undefined}
            onAskCombine={() => undefined}
            combineLocked={locked}
        >
            <button type="button">Bo</button>
        </PersonMenu>
    );

    it("is greyed out in a call of two, and live again with three", () => {
        const { rerender } = render(menu(true), { wrapper: MessagesWrapper });
        fireEvent.contextMenu(screen.getByText("Bo"));
        const ask = screen.getByRole("menuitem", { name: /Ask them to combine audio/ });
        expect(ask.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText("Needs at least three people in the call.")).toBeTruthy();

        rerender(menu(false));
        const again = screen.getByRole("menuitem", { name: /Ask them to combine audio/ });
        expect(again.getAttribute("aria-disabled")).toBeNull();
    });
});

describe("how loud the voices are", () => {
    it("is lowered by the attenuation only while a stream plays", () => {
        expect(voiceScale({ ducking: 0, streamPlaying: false, streamAttenuation: 30 })).toBe(1);
        expect(voiceScale({ ducking: 0, streamPlaying: true, streamAttenuation: 30 })).toBeCloseTo(
            0.7
        );
    });

    it("compounds with ducking while talking", () => {
        expect(voiceScale({ ducking: 50, streamPlaying: true, streamAttenuation: 50 })).toBeCloseTo(
            0.25
        );
    });
});

describe("sharing a window that stopped sending pictures", () => {
    it("tells the person sharing, and only while it is frozen", () => {
        const { rerender } = render(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call({ sharing: true, shareStill: true })}
                onLeave={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        // One line of the call's notices now: its words, and the whole sentence
        // read with them, announced politely.
        const line = screen.getByText(/stopped sending new pictures/).closest("[role]");
        expect(line?.getAttribute("role")).toBe("status");
        expect(line?.textContent).toContain("Your share stopped updating");
        rerender(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call({ sharing: true, shareStill: false })}
                onLeave={() => undefined}
            />
        );
        expect(screen.queryByText(/stopped sending new pictures/)).toBeNull();
    });
});
