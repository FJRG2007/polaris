/**
 * Your own call on a deck: mute, deafen, the camera, recording, hanging up and
 * the soundboard - Discord's Stream Deck keys, for a Polaris call.
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
import type { DeckCaller, DeckRunResult, DeckState } from "./types";

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
    record: { on: { icon: "circle-dot", tone: "bad" }, off: { icon: "circle-dot", tone: "idle" } }
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
            const on = which === "mic" ? !sent.on : sent.on;
            return { ok: true, state: switchState(which, on, caller.locale) };
        },
        read: async (_options, caller) => {
            const live = await remote.liveCallOf(caller.userId);
            if (!live) return noCallState(caller.locale);
            return switchState(which, switchOn(which, live.controls), caller.locale);
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
            read: async (_options, caller) =>
                (await remote.liveCallOf(caller.userId))
                    ? { tone: "bad", icon: "phone-off", detail: api(caller)("deck.call.inCall") }
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
