/**
 * Why a call is silent, and - just as importantly - when it is not.
 *
 * The failure being guarded against here is a call that carried no sound in
 * either direction while every screen said it was working. So what is checked is
 * that each of the four places sound is lost produces its own sentence, that the
 * one nearest the reader is named first, and that the ordinary reasons a call is
 * quiet - muted, alone, everybody else muted, quiet for a room - never raise an
 * alarm. A panel that cries wolf when somebody mutes themselves is a panel
 * nobody reads on the day it matters.
 */

import { describe, expect, it } from "vitest";
import {
    diagnoseCall,
    type CallAudioFacts,
    type HeardFrom
} from "@/app/(app)/chat/call-diagnosis";

/** A call in which everything works, as the starting point for changing exactly
 *  one thing about it. */
function working(over: Partial<CallAudioFacts> = {}): CallAudioFacts {
    return {
        link: "connected",
        mic: "sending",
        others: [heard()],
        deafened: false,
        companion: false,
        // A working call has been heard. The cases about a call that never had
        // a byte set this false for themselves.
        everHeard: true,
        ...over
    };
}

function heard(over: Partial<HeardFrom> = {}): HeardFrom {
    return {
        id: "p2",
        name: "Ana",
        muted: false,
        subscribed: true,
        arriving: true,
        carrying: true,
        turnedDown: false,
        ...over
    };
}

/** What one row of the panel says, by its label. */
function row(facts: CallAudioFacts, label: string): string {
    return diagnoseCall(facts).lines.find((line) => line.label === label)?.value ?? "";
}

describe("a call that works", () => {
    it("says nothing", () => {
        const report = diagnoseCall(working());
        expect(report.ok).toBe(true);
        expect(report.headline).toBe("");
    });

    it("still shows every check it made", () => {
        expect(diagnoseCall(working()).lines).toHaveLength(4);
        expect(row(working(), "What you are being sent")).toBe("Sound from 1 of 1");
    });
});

describe("the ordinary reasons a call is quiet", () => {
    it("does not treat muting yourself as a fault", () => {
        const report = diagnoseCall(working({ mic: "muted" }));
        expect(report.ok).toBe(true);
        expect(row(working({ mic: "muted" }), "Your microphone")).toBe("Muted");
    });

    it("does not treat being alone as a fault", () => {
        const report = diagnoseCall(working({ others: [] }));
        expect(report.ok).toBe(true);
        expect(row(working({ others: [] }), "What you are being sent")).toBe(
            "Nobody else is here"
        );
    });

    it("does not treat everybody else being muted as a fault", () => {
        const quiet = working({ others: [heard({ muted: true, carrying: false })] });
        expect(diagnoseCall(quiet).ok).toBe(true);
        expect(row(quiet, "What you are being sent")).toBe("Everybody else is muted");
    });

    it("does not treat a device that is quiet for a room as a fault", () => {
        // Nothing comes out of these speakers on purpose: the laptop next to it
        // is playing the room out loud - see `call-combine`.
        const beside = working({
            companion: true,
            mic: "muted",
            others: [heard({ carrying: false, arriving: false, subscribed: false })]
        });
        expect(diagnoseCall(beside).ok).toBe(true);
        expect(row(beside, "Sound here")).toBe("Playing on the device carrying the room");
    });

    it("says nothing while the call is still being joined", () => {
        const joining = working({
            link: "connecting",
            mic: "no-device",
            others: [heard({ subscribed: false, arriving: false, carrying: false })]
        });
        const report = diagnoseCall(joining);
        expect(report.ok).toBe(true);
        expect(report.headline).toBe("");
        // The rows are still there, so a reader who opens the call while it
        // connects sees the checks rather than an empty box.
        expect(report.lines).toHaveLength(4);
    });
});

describe("the connection", () => {
    it("is named before anything else, because nothing else means anything", () => {
        // A muted microphone and nobody heard from, on a connection that is
        // down. Only the connection is worth saying.
        const down = working({
            link: "lost",
            mic: "no-device",
            others: [heard({ subscribed: false, arriving: false, carrying: false })]
        });
        const report = diagnoseCall(down);
        expect(report.ok).toBe(false);
        expect(report.headline).toContain("not connected to the call server");
        expect(report.fix).toContain("Chat settings");
    });

    it("tells a client putting itself back together apart from one that gave up", () => {
        const report = diagnoseCall(working({ link: "reconnecting" }));
        expect(report.ok).toBe(false);
        expect(report.headline).toContain("reconnecting");
        // Nothing to do about it: it comes back on its own, and telling somebody
        // to rejoin mid-recovery is how a call that was fine gets dropped.
        expect(report.fix).toBe("");
    });
});

describe("this browser's own half", () => {
    it("says when no microphone was opened", () => {
        const report = diagnoseCall(working({ mic: "no-device" }));
        expect(report.headline).toContain("No microphone is open");
        expect(report.fix).toContain("address bar");
    });

    it("says when the device stopped underneath the call", () => {
        expect(diagnoseCall(working({ mic: "dead" })).headline).toContain("stopped");
    });

    it("tells a device picking nothing up apart from a person who is not talking", () => {
        const report = diagnoseCall(working({ mic: "no-input" }));
        expect(report.headline).toContain("picking nothing up");
        expect(report.fix).toContain("muted on the machine itself");
    });

    it("says when the microphone is open and never reached the wire", () => {
        expect(diagnoseCall(working({ mic: "unpublished" })).headline).toContain(
            "is not being sent"
        );
    });

    it("names deafening rather than blaming the other end for it", () => {
        const deaf = working({
            deafened: true,
            others: [heard({ carrying: false, arriving: false })]
        });
        const report = diagnoseCall(deaf);
        expect(report.headline).toContain("deafened yourself");
        expect(row(deaf, "Sound here")).toBe("Deafened");
    });

    it("says when everybody has been turned down to nothing here", () => {
        const down = working({ others: [heard({ turnedDown: true })] });
        expect(diagnoseCall(down).headline).toContain("turned down to nothing");
        expect(row(down, "Sound here")).toBe("Everybody turned down to nothing");
    });
});

describe("what is arriving", () => {
    it("names the person when nothing of theirs ever reached this device", () => {
        const alone = working({
            others: [heard({ subscribed: false, arriving: false, carrying: false })]
        });
        const report = diagnoseCall(alone);
        expect(report.headline).toContain("Ana");
        expect(report.headline).toContain("no audio of theirs has reached this device");
        expect(row(alone, "What you are being sent")).toBe("Nothing is being sent");
    });

    it("keeps the sentence general once there is more than one of them", () => {
        const room = working({
            others: [
                heard({ subscribed: false, arriving: false, carrying: false }),
                heard({ id: "p3", name: "Bo", subscribed: false, arriving: false, carrying: false })
            ]
        });
        expect(diagnoseCall(room).headline).toBe(
            "No audio has reached this device from anybody in this call."
        );
    });

    it("tells a subscribed track apart from one that is carrying anything", () => {
        // The failure that has no other symptom: the browser hands over a track
        // when the connection is described, so a call whose media never got
        // through looks identical to one that did.
        const stalled = working({
            others: [heard({ subscribed: true, arriving: false, carrying: false })]
        });
        const report = diagnoseCall(stalled);
        expect(report.headline).toBe("Their audio is not reaching this device.");
        expect(report.fix).toContain("between here and the call server");
        expect(row(stalled, "What you are being sent")).toBe("Not reaching this device");
    });

    it("says when their packets arrive and carry silence", () => {
        // The other end publishing a dead track: everything about the
        // connection is healthy and there is no sound in it.
        const silent = working({ others: [heard({ arriving: true, carrying: false })] });
        const report = diagnoseCall(silent);
        expect(report.headline).toContain("Ana");
        expect(report.headline).toContain("carries no sound");
        expect(report.fix).toContain("their machine");
        expect(row(silent, "What you are being sent")).toBe("Arriving, and silent");
    });

    it("is satisfied by one person being audible in a room of several", () => {
        const mixed = working({
            others: [
                heard(),
                heard({ id: "p3", name: "Bo", arriving: false, carrying: false })
            ]
        });
        expect(diagnoseCall(mixed).ok).toBe(true);
        expect(row(mixed, "What you are being sent")).toBe("Sound from 1 of 2");
    });

    it("ignores somebody who says they are muted when judging the rest", () => {
        const mixed = working({
            others: [
                heard({ muted: true, subscribed: false, arriving: false, carrying: false }),
                heard({ id: "p3", name: "Bo" })
            ]
        });
        expect(diagnoseCall(mixed).ok).toBe(true);
    });
});

describe("a call that has never had a byte of sound", () => {
    it("names the screen that measures rather than guessing at the cause", () => {
        // The fault the logs actually showed: signalling up, both names on
        // screen, and not one packet of audio in either direction. Telling
        // somebody to leave and rejoin sends them round that loop for ever.
        //
        // And it must not name a cause either. This used to open with "the two
        // of you are on different networks", which on this deployment was
        // false - the ports were open and the call server was handing out
        // addresses that only exist inside a container - and it cost somebody
        // days on a router that had nothing wrong with it.
        const report = diagnoseCall(
            working({ everHeard: false, others: [heard({ subscribed: false })] })
        );

        expect(report.ok).toBe(false);
        expect(report.fix).toContain("Call ports");
        expect(report.fix).not.toContain("different networks");
        expect(report.fix).not.toContain("Leave the call and join it again");
    });

    it("says the same when something subscribed but nothing ever arrived", () => {
        const report = diagnoseCall(working({ everHeard: false, others: [heard({ arriving: false })] }));

        expect(report.fix).toContain("Call ports");
    });

    it("still says rejoin for a call that had sound and lost it", () => {
        // A different fault with a different answer, and the reason the fact is
        // "ever" rather than "now".
        const report = diagnoseCall(working({ everHeard: true, others: [heard({ arriving: false })] }));

        expect(report.fix).toContain("between here and the call server");
        expect(report.fix).not.toContain("Call ports");
    });
});
