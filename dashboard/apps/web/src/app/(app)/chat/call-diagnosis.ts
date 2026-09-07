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
export type CallLink = "connecting" | "connected" | "reconnecting" | "lost" | "resting";

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
    /**
     * They have a microphone on the call at all.
     *
     * The difference between somebody whose sound is not getting here and
     * somebody who never shared a microphone in the first place - which is what
     * a browser that refused the permission looks like from the other side. Read
     * as one silence, both were reported as a fault in the call, and the advice
     * was to leave and rejoin: a sentence that blames Polaris for a permission
     * dialog somebody dismissed on their own machine.
     */
    readonly sharing: boolean;
    /**
     * The call server still hears from them.
     *
     * A closed tab is not a disconnection the instant it happens: the server
     * waits out its own timeout before it drops somebody, and for those seconds
     * they are still in the room with nothing arriving. That is a person who has
     * gone, not a call that is broken, and it is what this tells apart.
     */
    readonly reachable: boolean;
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
    /**
     * Whether one single audio packet has arrived from anybody since this call
     * started.
     *
     * The whole of the difference between two faults that look identical from
     * inside the call. Setting a call up goes over 443 with every other request,
     * through the edge; the sound does not - it goes straight to this machine on
     * its own port. So a call that says "connected" and has never once had a
     * byte of audio is not a server having a moment: it is the media path, and
     * telling somebody to leave and rejoin sends them round that loop for ever.
     *
     * True the moment anything arrives, and it stays true - a call that worked
     * and then went quiet is a different fault, and the advice for it is not
     * about ports.
     */
    readonly everHeard: boolean;
}

/** One row of the panel: a thing that was checked, and how it came out. */
export interface CallAudioLine {
    readonly label: string;
    readonly value: string;
    /** `idle` is a state that is nobody's fault, and stops the row being drawn
     *  as one: muted, alone in the call, quiet for a room. */
    readonly state: "good" | "bad" | "idle";
}

/**
 * Whose problem it is.
 *
 * `fault` is something wrong here, in this call, that this reader can usually do
 * something about. `theirs` is the other half and it is the reason this exists:
 * a person who closed their tab, or whose browser never let them share a
 * microphone, is not a failing call - and saying so in the same yellow warning,
 * with the same "leave and rejoin", tells somebody Polaris broke when Polaris did
 * nothing at all. It is still worth saying; it is not worth alarming anybody
 * about.
 */
export type CallAudioBlame = "fault" | "theirs";

/** What the call says about its own sound. */
export interface CallAudioReport {
    /** Whether sound should be working. False is what draws the panel at all. */
    readonly ok: boolean;
    /** Whether what is being reported is this call's problem or the other end's. */
    readonly blame: CallAudioBlame;
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
export const UNKNOWN_AUDIO: CallAudioReport = { ok: true, blame: "fault", headline: "", fix: "", lines: [] };

/** What a screen says when the call server is the thing to look at. Repeated in
 *  two headlines, and it is the same sentence both times. */
const REJOIN =
    "Leave the call and join it again. If it happens to everybody, an administrator can check the call server under Chat settings.";

/**
 * What a screen says when no sound has EVER arrived on this call.
 *
 * Named rather than written twice, because the two branches that reach it are
 * the same fault seen from one step apart: nothing subscribed, and nothing
 * arriving on what did.
 *
 * It says what is true and it says who can act, and it no longer says why.
 *
 * It used to open with "the two of you are on different networks and the sound
 * has no way through", and send the reader to the router. That was a guess
 * dressed as a diagnosis, and on this deployment it was the wrong one: the ports
 * were open, the two people were reachable, and the sound was failing because
 * the call server was handing out addresses that only exist inside a container.
 * Somebody spent days on a router that had nothing wrong with it, because a
 * sentence on a screen told them that was where to look.
 *
 * So it names the one screen that measures rather than guesses, and stops
 * there.
 */
const MEDIA_PATH =
    "Sound has not reached this device at all on this call. An administrator can see why under Settings, Domains, Call ports, which checks the connection from outside rather than guessing at it.";

/** The call server, as a row. */
function linkLine(link: CallLink): CallAudioLine {
    const label = "Call server";
    if (link === "connected") return { label, value: "Connected", state: "good" };
    if (link === "connecting") return { label, value: "Connecting", state: "idle" };
    if (link === "reconnecting") return { label, value: "Reconnecting", state: "bad" };
    // Alone in the call, so there is nothing to carry and the room behind it has
    // been let go of - see `REST_AFTER_MS`. Deliberately not "not connected":
    // that reads as a fault, and this is a call that is working and waiting.
    if (link === "resting") {
        return { label, value: "Waiting for somebody to join", state: "idle" };
    }
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
    // Neither of these is a fault in this call, so neither is drawn as one - and
    // both are read here, in the order `diagnoseCall` reads them, because the
    // counters below lag: sound that moved half a minute ago still reads as
    // carrying, and a row saying so under a headline saying they have gone is
    // the panel arguing with itself about the call it exists for.
    if (audible.every((person) => !person.reachable)) {
        return { label, value: "They have stopped answering", state: "idle" };
    }
    if (audible.every((person) => !person.sharing)) {
        return { label, value: "No microphone shared", state: "idle" };
    }
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
        blame: "fault",
        headline,
        fix,
        lines
    });
    /** The same, for something that is happening at the other end. Nothing here
     *  is wrong, so it is drawn as a note rather than as an alarm. */
    const theirs = (headline: string, fix: string): CallAudioReport => ({
        ok: false,
        blame: "theirs",
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

    // Gone, or going. A browser that was closed is still in the room until the
    // server times it out, and for those seconds it looks exactly like a call
    // that has broken - so it is named before anything here is blamed.
    if (audible.every((person) => !person.reachable)) {
        return theirs(
            audible.length === 1
                ? `${audible[0]?.name} has stopped answering. If they closed the tab or lost their connection, they will drop out of the call in a moment.`
                : "Nobody else is answering. If they closed their tabs or lost their connection, they will drop out of the call in a moment.",
            ""
        );
    }

    // Never shared one. What a refused permission looks like from this side, and
    // there is nothing here to repair: the answer is on their machine, in their
    // own browser, and it is theirs to give.
    if (audible.every((person) => !person.sharing)) {
        return theirs(
            audible.length === 1
                ? `${audible[0]?.name} has not shared a microphone with this call.`
                : "Nobody else has shared a microphone with this call.",
            "Their browser has to allow it, beside their own address bar. Nothing here needs changing."
        );
    }

    if (audible.every((person) => !person.subscribed)) {
        return said(
            audible.length === 1
                ? `${audible[0]?.name} is in this call and no audio of theirs has reached this device.`
                : "No audio has reached this device from anybody in this call.",
            // Never once, on a link that is up, is the media path - see
            // MEDIA_PATH. Rejoining is the answer to a call that had sound and
            // lost it, and it is the wrong one here.
            facts.everHeard ? REJOIN : MEDIA_PATH
        );
    }
    if (audible.every((person) => !person.arriving)) {
        return said(
            "Their audio is not reaching this device.",
            facts.everHeard
                ? "Sound is not getting through between here and the call server. Leave the call and join it again, and try a different network if it happens twice."
                : MEDIA_PATH
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

    return { ok: true, blame: "fault", headline: "", fix: "", lines };
}
