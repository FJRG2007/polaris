/**
 * Why a call has no sound.
 *
 * The failure this exists for is the one nobody can act on: two people in a
 * call, both faces on screen, both rings lighting up green, and neither of them
 * able to hear a word. Everything visible about that call says it is working.
 * The only thing Polaris offered was a pill asking for a press, which is the
 * answer to a completely different question, and pressing it changed nothing
 * because nothing about it was wrong.
 *
 * Sound in a call fails in four places and they need four different answers, so
 * the honest thing is to say which one it is:
 *
 * - **the connection** - this browser is not on the call server, so nothing is
 *   arriving and nothing is leaving;
 * - **this microphone** - it was never opened, it stopped, it is muted, or it is
 *   open and not on the wire;
 * - **what is arriving** - nobody is sending audio, or they are and it is not
 *   reaching here, or it reaches here and carries nothing;
 * - **these speakers** - deafened, turned down to nothing, or deliberately quiet
 *   because the laptop next to this one is carrying the room.
 *
 * Two of those are on the far side of the room and cannot be guessed at from a
 * track existing. A subscribed track is not a track carrying sound: the browser
 * hands one over when the connection is described, long before a single packet
 * has arrived, so "they are publishing a microphone" and "you can hear them" are
 * different facts and only the second is worth telling somebody. What separates
 * them is whether the counters move, which is what the caller samples and hands
 * in here.
 *
 * Everything below is arithmetic over facts somebody else measured, so the rules
 * can be checked without a call server, a browser or a microphone.
 */

/** How this browser stands with the call server. */
export type CallLink = "connecting" | "connected" | "reconnecting" | "lost";

/**
 * What this browser is doing with its own voice.
 *
 * `no-input` is the browser's own word for it: a track whose `muted` flag is set
 * is one the device has stopped delivering data for - a headset switched off at
 * the cable, an input taken by another application - which is not the same thing
 * as somebody pressing mute, and reads to everybody else as a person who has
 * gone quiet.
 */
export type MicSending = "no-device" | "dead" | "no-input" | "muted" | "unpublished" | "sending";

/** What is arriving from one other person in the call. */
export interface HeardFrom {
    readonly id: string;
    /** What to call them on screen. */
    readonly name: string;
    /** They say their microphone is off. Not a fault, and the reason most calls
     *  with somebody silent in them are working perfectly. */
    readonly muted: boolean;
    /** An audio track of theirs is subscribed to here. */
    readonly subscribed: boolean;
    /** Packets from them have arrived recently. */
    readonly arriving: boolean;
    /** Those packets carried sound rather than silence, recently. */
    readonly carrying: boolean;
    /** Turned down to nothing in this browser, which is this reader's own doing
     *  and has to be said rather than diagnosed around. */
    readonly turnedDown: boolean;
}

/** Everything the verdict is reached from. */
export interface CallAudioFacts {
    readonly link: CallLink;
    readonly mic: MicSending;
    /** Everybody else admitted to the call. */
    readonly others: readonly HeardFrom[];
    /** This pair of ears is switched off. */
    readonly deafened: boolean;
    /** This device is quiet on purpose because the one beside it carries the
     *  room - see `call-combine`. */
    readonly companion: boolean;
}

/** One row of the panel: a thing that was checked, and how it came out. */
export interface CallAudioLine {
    readonly label: string;
    readonly value: string;
    /** `idle` is a state that is nobody's fault, and stops the row being drawn
     *  as one: muted, alone in the call, quiet for a room. */
    readonly state: "good" | "bad" | "idle";
}

/** What the call says about its own sound. */
export interface CallAudioReport {
    /** Whether sound should be working. False is what draws the panel at all. */
    readonly ok: boolean;
    /** The first thing that is wrong, in the reader's own terms. Empty while
     *  nothing is. */
    readonly headline: string;
    /** What the reader can do about it. Empty where there is genuinely nothing,
     *  which is better than inventing a step. */
    readonly fix: string;
    readonly lines: readonly CallAudioLine[];
}

/** Before anything has been measured. Not a verdict: a call that has been up for
 *  half a second has not failed. */
export const UNKNOWN_AUDIO: CallAudioReport = { ok: true, headline: "", fix: "", lines: [] };

/** What a screen says when the call server is the thing to look at. Repeated in
 *  two headlines, and it is the same sentence both times. */
const REJOIN =
    "Leave the call and join it again. If it happens to everybody, an administrator can check the call server under Chat settings.";

/** The call server, as a row. */
function linkLine(link: CallLink): CallAudioLine {
    const label = "Call server";
    if (link === "connected") return { label, value: "Connected", state: "good" };
    if (link === "connecting") return { label, value: "Connecting", state: "idle" };
    if (link === "reconnecting") return { label, value: "Reconnecting", state: "bad" };
    return { label, value: "Not connected", state: "bad" };
}

/** This microphone, as a row. */
function micLine(mic: MicSending): CallAudioLine {
    const label = "Your microphone";
    switch (mic) {
        case "sending":
            return { label, value: "Being sent", state: "good" };
        case "muted":
            return { label, value: "Muted", state: "idle" };
        case "no-device":
            return { label, value: "None open", state: "bad" };
        case "dead":
            return { label, value: "Stopped", state: "bad" };
        case "no-input":
            return { label, value: "Open, picking nothing up", state: "bad" };
        case "unpublished":
            return { label, value: "Open, not being sent", state: "bad" };
    }
}

/** What is arriving, as a row. Counted rather than named, because a row that
 *  lists eight people is a row nobody reads. */
function heardLine(others: readonly HeardFrom[]): CallAudioLine {
    const label = "What you are being sent";
    if (others.length === 0) return { label, value: "Nobody else is here", state: "idle" };
    const audible = others.filter((person) => !person.muted);
    if (audible.length === 0) return { label, value: "Everybody else is muted", state: "idle" };
    const carrying = audible.filter((person) => person.carrying).length;
    if (carrying > 0) {
        return { label, value: `Sound from ${carrying} of ${audible.length}`, state: "good" };
    }
    if (audible.some((person) => person.arriving)) {
        return { label, value: "Arriving, and silent", state: "bad" };
    }
    if (audible.some((person) => person.subscribed)) {
        return { label, value: "Not reaching this device", state: "bad" };
    }
    return { label, value: "Nothing is being sent", state: "bad" };
}

/** These speakers, as a row. */
function playbackLine(facts: CallAudioFacts): CallAudioLine {
    const label = "Sound here";
    if (facts.deafened) return { label, value: "Deafened", state: "bad" };
    if (facts.companion) {
        return { label, value: "Playing on the device carrying the room", state: "idle" };
    }
    const audible = facts.others.filter((person) => !person.muted);
    if (audible.length > 0 && audible.every((person) => person.turnedDown)) {
        return { label, value: "Everybody turned down to nothing", state: "bad" };
    }
    return { label, value: "On", state: "good" };
}

/**
 * What is wrong with the sound in this call, or nothing.
 *
 * One answer, in the order the reader can do something about it: the connection
 * first, because with it down every other row is meaningless; then this
 * browser's own half, because it is the half they can fix; then the far end.
 *
 * Being muted, being alone and being quiet for a room are not failures and
 * produce no headline. A panel that appears every time somebody mutes themselves
 * is a panel people learn to ignore, which costs exactly the call this was built
 * for.
 */
export function diagnoseCall(facts: CallAudioFacts): CallAudioReport {
    const lines: CallAudioLine[] = [
        linkLine(facts.link),
        micLine(facts.mic),
        heardLine(facts.others),
        playbackLine(facts)
    ];
    const said = (headline: string, fix: string): CallAudioReport => ({
        ok: false,
        headline,
        fix,
        lines
    });

    if (facts.link === "lost") {
        return said(
            "This device is not connected to the call server, so nothing is arriving and nothing is leaving.",
            REJOIN
        );
    }
    if (facts.link === "reconnecting") {
        return said("This device is reconnecting to the call server.", "");
    }
    // Still joining, which is not a fault yet. The rows are handed back so the
    // panel can be opened and read while it happens.
    if (facts.link === "connecting") return { ...UNKNOWN_AUDIO, lines };

    if (facts.mic === "no-device") {
        return said(
            "No microphone is open, so nobody can hear you.",
            "Pick one from the microphone button, or allow Polaris to use it in the address bar."
        );
    }
    if (facts.mic === "dead") {
        return said(
            "Your microphone stopped, so nobody can hear you.",
            "Pick it again from the microphone button."
        );
    }
    if (facts.mic === "no-input") {
        return said(
            "Your microphone is open and picking nothing up.",
            "Check it is not muted on the machine itself, and that nothing else is holding it."
        );
    }
    if (facts.mic === "unpublished") {
        return said(
            "Your microphone is open but is not being sent, so nobody can hear you.",
            "Leave the call and join it again."
        );
    }

    if (facts.deafened) {
        return said(
            "You have deafened yourself, so you hear nobody.",
            "Press the headphones button."
        );
    }

    // Quiet on purpose, and none of the questions below are this reader's to
    // answer: nothing is played here because the device beside this one is
    // playing the room out loud - see `call-combine`. Sending them after a fault
    // in audio they were never going to hear is the panel wasting the one piece
    // of attention it gets.
    if (facts.companion) return { ...UNKNOWN_AUDIO, lines };

    const audible = facts.others.filter((person) => !person.muted);
    // Nobody to hear. A call where everybody else is muted is a working call.
    if (audible.length === 0) return { ...UNKNOWN_AUDIO, lines };

    if (audible.every((person) => !person.subscribed)) {
        return said(
            audible.length === 1
                ? `${audible[0]?.name} is in this call and no audio of theirs has reached this device.`
                : "No audio has reached this device from anybody in this call.",
            REJOIN
        );
    }
    if (audible.every((person) => !person.arriving)) {
        return said(
            "Their audio is not reaching this device.",
            "Sound is not getting through between here and the call server. Leave the call and join it again, and try a different network if it happens twice."
        );
    }
    if (audible.every((person) => !person.carrying)) {
        return said(
            audible.length === 1
                ? `${audible[0]?.name} is being sent, and what arrives carries no sound.`
                : "What arrives from the others carries no sound.",
            "Their microphone is picking nothing up. They can check it is not muted on their machine, and pick a different one from the microphone button."
        );
    }
    if (audible.every((person) => person.turnedDown)) {
        return said(
            "Everybody in this call is turned down to nothing in this browser.",
            "Right-click somebody's tile to turn them back up."
        );
    }

    return { ok: true, headline: "", fix: "", lines };
}
