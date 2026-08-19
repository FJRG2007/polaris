// @vitest-environment jsdom

/**
 * Who plays a person: the element, or the graph.
 *
 * An `<audio>` element's volume stops at 1. Everything a call has ever done with
 * volume happens under that ceiling and should go on happening there, because it
 * costs nothing - so the graph exists for exactly one case, somebody turned up
 * past how they were sent, and it must not be built for anybody else.
 *
 * The two failures worth guarding against are both silent ones. A boosted person
 * played by the element *and* the graph arrives twice, which is not louder, it is
 * doubled and wrong. And a graph left running while the reader is deafened goes
 * on playing the very people they had turned up - deafening mutes the element,
 * which says nothing at all to Web Audio.
 */

import { CallAudio } from "@/app/(app)/chat/call-audio";
import { cleanup, render } from "@testing-library/react";
import type { CallState } from "@/app/(app)/chat/call-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let volume = 1;
const built: number[] = [];
const setTo: number[] = [];
let stopped = 0;

vi.mock("@/app/(app)/chat/call-volumes", () => ({
    useCallVolume: () => [volume, () => undefined]
}));

vi.mock("@/app/(app)/chat/call-boost", () => ({
    resumeBoost: () => undefined,
    boostStream: (_stream: MediaStream, level: number) => {
        built.push(level);
        return {
            set: (next: number) => setTo.push(next),
            stop: () => {
                stopped += 1;
            }
        };
    }
}));

/** A call with one other person in it, whose sound is what all of this is about. */
function callWith(deafened: boolean): CallState {
    const stream = { id: "s1" } as unknown as MediaStream;
    return {
        meeting: {
            id: "m1",
            channelId: null,
            hostId: "ada",
            title: "",
            startedAt: "",
            ended: false,
            guestToken: null,
            approveGuests: true,
            participants: [
                {
                    id: "p-grace",
                    userId: "grace",
                    name: "Grace",
                    admission: "admitted",
                    guest: false,
                    joinedAt: ""
                }
            ]
        },
        participantId: "p-ada",
        remote: new Map([["p-grace", stream]]),
        deafened
    } as unknown as CallState;
}

/** The one audio element the room draws for the one other person in it. */
function played(): HTMLAudioElement {
    const audio = document.querySelector("audio");
    if (!audio) throw new Error("no audio element was drawn");
    return audio;
}

beforeEach(() => {
    volume = 1;
    built.length = 0;
    setTo.length = 0;
    stopped = 0;
    HTMLMediaElement.prototype.play = () => Promise.resolve();
});

afterEach(cleanup);

describe("playing somebody in a call", () => {
    it("leaves it to the element at or below how they were sent", () => {
        volume = 0.5;
        render(<CallAudio call={callWith(false)} />);

        expect(built).toEqual([]);
        expect(played().volume).toBe(0.5);
    });

    it("builds the graph past it, and silences the element so it is not doubled", () => {
        volume = 2;
        render(<CallAudio call={callWith(false)} />);

        expect(built).toEqual([2]);
        expect(played().volume).toBe(0);
    });

    it("stops the graph for a reader who has deafened themselves", () => {
        volume = 2;
        const view = render(<CallAudio call={callWith(false)} />);
        expect(built).toEqual([2]);

        view.rerender(<CallAudio call={callWith(true)} />);
        expect(stopped).toBe(1);
    });
});
