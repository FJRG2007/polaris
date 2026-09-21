// @vitest-environment jsdom
/**
 * Watching somebody's stream in a direct message, and what right-clicking it
 * offers.
 *
 * In a direct message a share is offered, not taken, and the offer sits among
 * the people - first, to their left - rather than in a row above them. Once
 * watched, the stream has the band to itself, and letting go of it brings the
 * people back; with the call expanded, the people are a row under it. Right-clicking
 * the stream mutes it, sets its volume, pops it out and sets how far voices are
 * lowered while it plays; right-clicking a person in a call of two shows
 * combining greyed out.
 */

import type { CallState } from "@/app/(app)/chat/call-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
    setWatchedStreams,
    streamMuted,
    voiceScale,
    watchedStreams
} from "@/app/(app)/chat/call-stream-audio";

vi.mock("@/app/(app)/chat/meeting-actions", () => ({ admitAction: async () => ({}) }));
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
    constructor(private readonly audio: number) {}
    getAudioTracks() {
        return Array.from({ length: this.audio }, () => ({ kind: "audio" }));
    }
    getVideoTracks() {
        return [video];
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
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
        configurable: true,
        value: () => Promise.resolve()
    });
});
afterEach(cleanup);

describe("a stream in a direct message", () => {
    it("is offered to the left of the people rather than above them", () => {
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />);
        const card = screen.getByTitle("Watch Bo - screen");
        const row = card.closest("ul")!;
        const items = within(row).getAllByRole("listitem");
        expect(items[0]!.contains(card)).toBe(true);
        expect(within(row).getByText("You")).toBeTruthy();
        expect(within(row).getByText("Bo")).toBeTruthy();
        expect(watchedStreams()).toEqual([]);
    });

    it("shows only the stream once it is watched, and the people again once let go", () => {
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />);
        fireEvent.click(screen.getByTitle("Watch Bo - screen"));
        expect(watchedStreams()).toEqual(["screen:seat-bo"]);
        expect(document.querySelector("video")).toBeTruthy();
        // The band holds the picture alone: no faces, no tiles of people.
        expect(screen.queryByText("You")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Back to the people" }));
        expect(watchedStreams()).toEqual([]);
        expect(screen.getByText("You")).toBeTruthy();
        expect(screen.getByTitle("Watch Bo - screen")).toBeTruthy();
    });

    it("lists the people in a row under the stream once the call is expanded", () => {
        render(
            <CallRoom
                meetingId="m1"
                place="direct"
                call={call()}
                expanded
                onExpand={() => undefined}
                onLeave={() => undefined}
            />
        );
        fireEvent.click(screen.getByTitle("Watch Bo - screen"));
        const stream = document.querySelector("video")!;
        const you = screen.getByText("You");
        // After the stream in the document, which in a column is under it.
        expect(stream.compareDocumentPosition(you) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByText("Bo")).toBeTruthy();

        // Asked for by name, the stream takes the call whole.
        fireEvent.click(screen.getByRole("button", { name: "Make this bigger" }));
        expect(screen.queryByText("You")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Back to the grid" }));
        expect(screen.getByText("You")).toBeTruthy();
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
            />
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
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />);
        expect(screen.getAllByRole("img", { name: "Sharing a screen" })).toHaveLength(1);
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
        render(<CallRoom meetingId="m1" place="direct" call={call()} onLeave={() => undefined} />);
        fireEvent.contextMenu(screen.getByTitle("Watch Bo - screen"));
        expect(screen.getByRole("menuitem", { name: /Pop out/ })).toBeTruthy();
        expect(screen.getByLabelText("How loud Bo - screen is")).toBeTruthy();
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
            />
        );
        fireEvent.contextMenu(screen.getByTitle("Watch Bo - screen"));
        expect(screen.getByText("This stream has no sound.")).toBeTruthy();
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
            />
        );
        fireEvent.click(screen.getByTitle("Watch Bo - screen"));
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
        render(<CallRoom meetingId="m1" place="room" call={call()} onLeave={() => undefined} />);
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
        const { rerender } = render(menu(true));
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
