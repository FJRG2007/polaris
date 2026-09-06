/**
 * A call with one person in it.
 *
 * Nothing published reaches anybody: there is no subscriber, so every packet is
 * encoded, sent and thrown away, and the room is a session the media server
 * holds for an audience of nobody. On a machine running everything else Polaris
 * runs, that is a cost paid for somebody sitting alone waiting.
 *
 * What this guards is the line the whole design rests on: **the room is not the
 * call**. Who is in a call is Polaris' own fact - the roster, the presence, the
 * badge on the channel - so letting the room go changes nothing anybody else can
 * see. What is tested here is the sentence the reader is shown for it, because
 * the failure mode is a working call that reads as a broken one.
 */

import { describe, expect, it } from "vitest";
import { diagnoseCall, type CallLink } from "@/app/(app)/chat/call-diagnosis";

/** The panel's row about the call server, for one state of the link and with
 *  everything else settled. */
function serverRow(link: CallLink) {
    return diagnoseCall({
        link,
        mic: "sending",
        others: [],
        deafened: false,
        companion: false,
        everHeard: true
    }).lines.find((row) => row.label === "Call server");
}

describe("what the panel says about the call server", () => {
    it("calls a working connection connected", () => {
        expect(serverRow("connected")).toMatchObject({ value: "Connected", state: "good" });
    });

    /**
     * The one that matters. Somebody alone in a call has no room behind it by
     * design, and "Not connected" over a call that is working is the sentence
     * that sends them to an administrator about nothing at all.
     */
    it("calls a room let go of a wait, not a failure", () => {
        const row = serverRow("resting");
        expect(row?.value).toBe("Waiting for somebody to join");
        expect(row?.state).toBe("idle");
    });

    it("still calls a lost connection lost", () => {
        expect(serverRow("lost")).toMatchObject({ state: "bad" });
        expect(serverRow("reconnecting")).toMatchObject({ state: "bad" });
    });
});
