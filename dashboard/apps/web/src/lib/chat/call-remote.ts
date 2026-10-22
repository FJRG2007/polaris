/**
 * A call worked from somewhere else: a Stream Deck key muting the microphone of
 * the tab that is actually on the call.
 *
 * The call runs in the browser - the microphone, the camera and the recorder
 * are that tab's, and the server never holds any of them - so a key cannot mute
 * anything itself. It asks the server, the server finds the seat the person is
 * sitting in and says so on the call's own stream (`meeting-events`), which
 * only the browser holding that seat is listening to. That browser does it,
 * and its next beat on the seat says what it is now, which is what the key
 * reads back.
 *
 * Client-safe: the command's shape, the rule for who may record, what a tab
 * does with a command, and the in-tab hand-off from the stream to the provider
 * that holds the recorder.
 */

import { z } from "zod";
import { soundPlayedSchema } from "./soundboard";

/** The switches a command sets. `on` is where the switch should end up, never
 *  "flip": a press read twice is then still one press. */
export const CALL_SWITCHES = ["mic", "deafen", "camera", "record", "share"] as const;

export type CallSwitch = (typeof CALL_SWITCHES)[number];

export const callRemoteSchema = z.discriminatedUnion("command", [
    z.object({ command: z.enum(CALL_SWITCHES), on: z.boolean() }),
    z.object({ command: z.literal("hangup") }),
    /** A sound the server played to a room with nobody else in it: the call
     *  server had nobody to hand it to, so this tab sounds it itself, the way
     *  the picker does. */
    z.object({ command: z.literal("sound"), played: soundPlayedSchema })
]);

export type CallRemoteCommand = z.infer<typeof callRemoteSchema>;

/**
 * Whether somebody may record this call: its host, or anybody in a direct
 * message or a group, where everybody is an equal. The call screen's own rule,
 * kept here so the screen and a deck key ask the same question.
 */
export function mayRecordCall(input: {
    readonly viewerId: string | null | undefined;
    readonly hostId: string | null | undefined;
    readonly channelKind: string | null | undefined;
}): boolean {
    if (!input.viewerId) return false;
    if (input.hostId === input.viewerId) return true;
    return input.channelKind === "dm" || input.channelKind === "group";
}

/** What a tab holds right now, as far as a command is concerned. */
export interface RemoteControls {
    readonly micOn: boolean;
    readonly deafened: boolean;
    readonly cameraOn: boolean;
    readonly recording: boolean;
    /** Whether this browser can record at all. */
    readonly canRecord: boolean;
    /** Whether this tab is sharing its screen. Absent is not sharing. */
    readonly sharing?: boolean;
    /** Whether this browser can share a screen at all. Absent is that it can. */
    readonly canShare?: boolean;
}

export type RemoteStep =
    | "toggleMic"
    | "toggleDeafen"
    | "toggleCamera"
    | "startRecording"
    | "stopRecording"
    | "startShare"
    | "stopShare"
    | "hangup"
    | "sound";

/** What a tab does with a command: nothing when it already is where the
 *  command wants it, so a repeated command is harmless. */
export function remoteStep(command: CallRemoteCommand, now: RemoteControls): RemoteStep | null {
    switch (command.command) {
        case "mic": {
            // Heard is what the seat reports and the key reads: deafened is
            // muted too, and unmuting from a deck takes the headphones off as
            // well, as the mute button does.
            const heard = now.micOn && !now.deafened;
            if (command.on === heard) return null;
            return command.on && now.micOn ? "toggleDeafen" : "toggleMic";
        }
        case "deafen":
            return command.on === now.deafened ? null : "toggleDeafen";
        case "camera":
            return command.on === now.cameraOn ? null : "toggleCamera";
        case "record":
            if (command.on === now.recording) return null;
            if (command.on && !now.canRecord) return null;
            return command.on ? "startRecording" : "stopRecording";
        case "share":
            if (command.on === Boolean(now.sharing)) return null;
            if (command.on && now.canShare === false) return null;
            return command.on ? "startShare" : "stopShare";
        case "hangup":
            return "hangup";
        case "sound":
            return "sound";
    }
}

type Listener = (command: CallRemoteCommand) => void;

const LISTENERS = Symbol.for("polaris.chat.call-remote");

function listeners(): Set<Listener> {
    const holder = globalThis as { [LISTENERS]?: Set<Listener> };
    holder[LISTENERS] ??= new Set();
    return holder[LISTENERS];
}

/** Hand a command that arrived on the call's stream to whoever acts on it. */
export function emitCallRemote(command: CallRemoteCommand): void {
    for (const listener of listeners()) {
        try {
            listener(command);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Listen until the returned function is called. */
export function onCallRemote(listener: Listener): () => void {
    const set = listeners();
    set.add(listener);
    return () => set.delete(listener);
}
