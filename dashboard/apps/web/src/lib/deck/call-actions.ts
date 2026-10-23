/**
 * Your own call on a deck: mute, deafen, the camera, recording, sharing your
 * screen, hanging up and the soundboard - Discord's Stream Deck keys, for a
 * Polaris call.
 *
 * Sharing is the one a key can only half do. A browser opens its screen picker
 * only from a press on the page itself, so a key stops a share at once, and to
 * start one it puts the share button in front of the person, one click away
 * (`call-remote-hook`) - the key says so rather than claiming it went live.
 *
 * Nothing here touches a microphone. The call is in the person's browser; a
 * press finds the seat they are sitting in and asks that tab to do it
 * (`lib/chat/call-remote-service`), and the key's state is what that tab last
 * said on its seat. Not in a call, every key says so and a press does nothing.
 *
 * `chat.use` is the scope: a call is part of the chat, the seat itself proves
 * the person joined it, and a deck connected before these keys existed carries
 * it already.
 *
 * Server-only.
 */

import { z } from "zod";
import { guardChat } from "@/lib/chat/chat-guard";
import { translatorFor } from "@/lib/i18n/translate";
import type { CoreDeckAction } from "./core-actions";
import { soundRefSchema } from "@/lib/chat/soundboard";
import * as remote from "@/lib/chat/call-remote-service";
import type { CallSwitch } from "@/lib/chat/call-remote";
import type { DeckAlso, DeckCaller, DeckPress, DeckRunResult, DeckState } from "./types";

/** What one switch looks like on a key, on and off. */
const LOOKS: Readonly<
    Record<
        CallSwitch,
        {
            on: { icon: string; tone: DeckState["tone"] };
            off: { icon: string; tone: DeckState["tone"] };
        }
    >
> = {
    // On is muted: the key lights up when nobody can hear you, as Discord's does.
    mic: { on: { icon: "mic-off", tone: "warn" }, off: { icon: "mic", tone: "idle" } },
    deafen: {
        on: { icon: "headphone-off", tone: "warn" },
        off: { icon: "headphones", tone: "idle" }
    },
    camera: { on: { icon: "video", tone: "ok" }, off: { icon: "video-off", tone: "idle" } },
    record: { on: { icon: "circle-dot", tone: "bad" }, off: { icon: "circle-dot", tone: "idle" } },
    share: {
        on: { icon: "screen-share", tone: "ok" },
        off: { icon: "screen-share", tone: "idle" }
    }
};

function api(caller: DeckCaller) {
    return translatorFor(caller.locale, "api");
}

/** Whether a switch is on, as its key draws it, from the seat's controls. */
export function switchOn(which: CallSwitch, controls: remote.SeatControls): boolean {
    switch (which) {
        case "mic":
            return controls.muted;
        case "deafen":
            return controls.deafened;
        case "camera":
            return controls.camera;
        case "record":
            return controls.recording;
        case "share":
            return controls.sharing;
    }
}

/** A switch's key, on or off, in its reader's words. */
export function switchState(
    which: CallSwitch,
    on: boolean,
    locale: DeckCaller["locale"]
): DeckState {
    const look = on ? LOOKS[which].on : LOOKS[which].off;
    return {
        tone: look.tone,
        on,
        icon: look.icon,
        detail: translatorFor(locale, "api")(`deck.call.${which}.${on ? "on" : "off"}`)
    };
}

/** The switches, in the order their keys are offered. */
const SWITCHES: readonly CallSwitch[] = ["mic", "deafen", "camera", "record", "share"];

/** What a press is worked out from: the seat's controls, and what undeafening
 *  gives back. */
type Seat = Pick<remote.LiveCall, "controls" | "mutedBeforeDeafen">;

/**
 * Where a press of `which` leaves the seat, by the call screen's own rules
 * (`call-voice-controls`, `remoteStep`): deafening mutes as well, unmuting
 * while deafened takes the headphones off too, and undeafening gives the
 * microphone back as it was before - left where it is when this server did
 * not see the seat deafen. A share is not started from a key, so asking for
 * one changes nothing yet.
 */
export function afterPress(which: CallSwitch, seat: Seat): Seat {
    const now = seat.controls;
    const kept = seat.mutedBeforeDeafen;
    switch (which) {
        case "mic":
            return now.muted
                ? {
                      controls: { ...now, muted: false, deafened: false },
                      mutedBeforeDeafen: undefined
                  }
                : { controls: { ...now, muted: true }, mutedBeforeDeafen: kept };
        case "deafen":
            return now.deafened
                ? {
                      controls: { ...now, deafened: false, muted: kept ?? now.muted },
                      mutedBeforeDeafen: undefined
                  }
                : {
                      controls: { ...now, deafened: true, muted: true },
                      mutedBeforeDeafen: now.muted
                  };
        case "camera":
            return { controls: { ...now, camera: !now.camera }, mutedBeforeDeafen: kept };
        case "record":
            return { controls: { ...now, recording: !now.recording }, mutedBeforeDeafen: kept };
        case "share":
            return now.sharing
                ? { controls: { ...now, sharing: false }, mutedBeforeDeafen: kept }
                : { controls: now, mutedBeforeDeafen: kept };
    }
}

/** A share asked for from a key: still off, waiting on the screen picker. */
function shareAsked(locale: DeckCaller["locale"]): DeckState {
    return {
        ...switchState("share", false, locale),
        detail: translatorFor(locale, "api")("deck.call.share.asked")
    };
}

/**
 * What a press of `which` shows before the tab on the call has done it: its
 * own key, and every other call key it moves - the microphone's, when the
 * headphones go on. Recording somebody the call would refuse it to changes
 * nothing, so the key keeps its face until the refusal comes back.
 */
export function callPress(
    which: CallSwitch,
    seat: Seat & Pick<remote.LiveCall, "mayRecord">,
    locale: DeckCaller["locale"]
): DeckPress {
    if (which === "record" && !seat.mayRecord && !seat.controls.recording) return { noop: true };
    const next = afterPress(which, seat).controls;
    const face =
        which === "share" && !seat.controls.sharing
            ? shareAsked(locale)
            : switchState(which, switchOn(which, next), locale);
    const also: DeckAlso[] = SWITCHES.filter(
        (other) => other !== which && switchOn(other, next) !== switchOn(other, seat.controls)
    ).map((other) => ({
        action: `call.${other}`,
        face: switchState(other, switchOn(other, next), locale)
    }));
    return also.length > 0 ? { face, also } : { face };
}

/** A switch's key in a call, with what pressing it does from there. */
export function seatState(
    which: CallSwitch,
    seat: Seat & Pick<remote.LiveCall, "mayRecord">,
    locale: DeckCaller["locale"]
): DeckState {
    return {
        ...switchState(which, switchOn(which, seat.controls), locale),
        press: callPress(which, seat, locale)
    };
}

/** What hanging up shows at once: out of a call, on every call key. */
export function hangUpPress(locale: DeckCaller["locale"]): DeckPress {
    const out = noCallState(locale);
    return {
        face: out,
        also: [...SWITCHES.map((which) => `call.${which}`), "call.sound"].map((action) => ({
            action,
            face: out
        }))
    };
}

/** Every call key, out of a call. */
export function noCallState(locale: DeckCaller["locale"]): DeckState {
    return { tone: "idle", detail: translatorFor(locale, "api")("deck.call.none") };
}

function refusal(caller: DeckCaller, why: remote.RemoteRefusal): DeckRunResult {
    return { ok: false, message: api(caller)(`deck.call.errors.${why}`) };
}

function switchAction(which: CallSwitch, icon: string): CoreDeckAction {
    return {
        id: `call.${which}`,
        kind: "toggle",
        area: "call",
        icon,
        scope: "chat.use",
        options: z.object({}),
        fields: [],
        run: async (_options, caller) => {
            const sent = await remote.flipCallSwitch(caller.userId, which);
            if (!sent.ok) return refusal(caller, sent.refusal);
            // Where it was asked to go; the tab's next word on the seat confirms it.
            const next = { ...sent.live, ...afterPress(which, sent.live) };
            // A share is not started from here: the tab offers its button.
            if (which === "share" && sent.on) {
                return {
                    ok: true,
                    state: {
                        ...shareAsked(caller.locale),
                        press: callPress(which, next, caller.locale)
                    }
                };
            }
            return { ok: true, state: seatState(which, next, caller.locale) };
        },
        read: async (_options, caller) => {
            const live = await remote.liveCallOf(caller.userId);
            if (!live) return noCallState(caller.locale);
            return seatState(which, live, caller.locale);
        },
        wakes: "call"
    };
}

/** The call keys core offers. */
export function callDeckActions(): readonly CoreDeckAction[] {
    return [
        switchAction("mic", "mic"),
        switchAction("deafen", "headphones"),
        switchAction("camera", "video"),
        switchAction("record", "circle-dot"),
        switchAction("share", "screen-share"),
        {
            id: "call.hangup",
            kind: "run",
            area: "call",
            icon: "phone-off",
            scope: "chat.use",
            options: z.object({}),
            fields: [],
            run: async (_options, caller) => {
                const sent = await remote.hangUpCall(caller.userId);
                return sent.ok
                    ? { ok: true, state: noCallState(caller.locale) }
                    : refusal(caller, sent.refusal);
            },
            // Hanging up ends every call key, so all of them say so at once.
            read: async (_options, caller) =>
                (await remote.liveCallOf(caller.userId))
                    ? {
                          tone: "bad",
                          icon: "phone-off",
                          detail: api(caller)("deck.call.inCall"),
                          press: hangUpPress(caller.locale)
                      }
                    : noCallState(caller.locale),
            wakes: "call"
        },
        {
            id: "call.sound",
            kind: "run",
            area: "call",
            icon: "volume-2",
            scope: "chat.use",
            options: z.object({ sound: soundRefSchema }),
            fields: [
                {
                    name: "sound",
                    type: "choice",
                    required: true,
                    read: (caller) =>
                        remote.deckSounds(caller.userId, (id) =>
                            translatorFor(caller.locale, "chat")(`soundboard.defaults.${id}`)
                        )
                }
            ],
            // The soundboard's own play, with all of its checks; a refusal it
            // words - the cooldown, a sound from a space this call does not
            // take - is what the key's owner reads.
            run: async (options, caller) => {
                const result = await guardChat(() =>
                    remote.playCallSound(caller.userId, String(options.sound))
                );
                if (result.error || !result.value)
                    return {
                        ok: false,
                        message: result.error ?? api(caller)("deck.errors.refused")
                    };
                return result.value.ok ? { ok: true } : refusal(caller, result.value.refusal);
            },
            read: async (_options, caller) =>
                (await remote.liveCallOf(caller.userId))
                    ? { tone: "idle" }
                    : noCallState(caller.locale),
            wakes: "call"
        }
    ];
}
