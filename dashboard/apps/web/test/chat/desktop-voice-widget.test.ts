/**
 * What the call tells the desktop app's voice widget: everybody admitted, the
 * reader first, each with whether they are talking, muted or deafened.
 */

import { describe, expect, it } from "vitest";
import { voiceWidgetState } from "@/app/(app)/chat/desktop-voice-widget";

type Call = Parameters<typeof voiceWidgetState>[0];

function call(overrides: Partial<Call> = {}): Call {
    return {
        meeting: {
            participants: [
                { id: "p-ada", name: "Ada Lovelace", admission: "admitted" },
                { id: "p-me", name: "Grace Hopper", admission: "admitted" },
                { id: "p-wait", name: "Waiting Guest", admission: "waiting" }
            ]
        },
        participantId: "p-me",
        speaking: new Set(["p-ada", "p-me"]),
        states: new Map([["p-ada", { muted: false, deafened: true }]]),
        micOn: true,
        deafened: false,
        ...overrides
    } as unknown as Call;
}

describe("the voice widget's state", () => {
    it("lists the admitted people, the reader first", () => {
        expect(voiceWidgetState(call())).toEqual({
            participants: [
                { id: "p-me", name: "Grace Hopper", speaking: true, muted: false, deafened: false },
                { id: "p-ada", name: "Ada Lovelace", speaking: true, muted: false, deafened: true }
            ],
            selfMuted: false,
            selfDeafened: false
        });
    });

    it("never shows the reader talking into a muted microphone", () => {
        const state = voiceWidgetState(call({ micOn: false, deafened: true }));
        expect(state.participants[0]).toMatchObject({ id: "p-me", speaking: false, muted: true, deafened: true });
        expect(state).toMatchObject({ selfMuted: true, selfDeafened: true });
    });

    it("is empty before the meeting is known", () => {
        expect(voiceWidgetState(call({ meeting: null })).participants).toEqual([]);
    });

    it("takes no more people than the app does", () => {
        const many = Array.from({ length: 80 }, (_, index) => ({
            id: `p-${index}`,
            name: `Person ${index}`,
            admission: "admitted"
        }));
        const meeting = { participants: many } as unknown as Call["meeting"];
        expect(voiceWidgetState(call({ meeting })).participants).toHaveLength(50);
    });

    it("names each account's face only for an app that draws them", () => {
        const meeting = {
            participants: [
                { id: "p-me", userId: "u-me", name: "Grace Hopper", admission: "admitted" },
                { id: "p-guest", userId: null, name: "Visitor", admission: "admitted" }
            ]
        } as unknown as Call["meeting"];
        const drawn = voiceWidgetState(call({ meeting }), true).participants;
        expect(drawn.map((person) => person.picture)).toEqual(["/api/avatar/u-me", undefined]);
        // An older app refuses a state with a field it does not know.
        const older = voiceWidgetState(call({ meeting })).participants;
        expect(older.every((person) => !("picture" in person))).toBe(true);
    });
});
