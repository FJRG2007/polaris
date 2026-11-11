/**
 * Holding the call's keys system-wide while a Polaris window is in a call.
 *
 * One window holds them at a time - the one that asked last - because two
 * holders of the same key would each toggle and a press would undo itself.
 * They are let go when that window says the call ended, when it navigates
 * away or closes, and when the app quits.
 */

import { CHANNELS } from "@/shared/bridge";
import { globalShortcut, type WebContents } from "electron";
import {
    callAccelerators,
    type CallHotkeysInput,
    type CallHotkeysResult
} from "@/shared/call-hotkeys";

let holder: WebContents | null = null;
let held: string[] = [];

function release(): void {
    for (const accelerator of held) {
        try {
            globalShortcut.unregister(accelerator);
        } catch {
            // Already gone with the window.
        }
    }
    held = [];
    holder = null;
}

/** Take the keys for `sender`, or let them go with null. Says which controls
 *  the system gave: a key another program already holds is not taken. */
export function setCallHotkeys(sender: WebContents, input: CallHotkeysInput): CallHotkeysResult {
    if (holder && holder !== sender && input === null) return { mic: false, deafen: false };
    release();
    if (input === null) return { mic: false, deafen: false };
    const result = { mic: false, deafen: false };
    for (const [accelerator, which] of callAccelerators(input)) {
        let ok = false;
        try {
            ok = globalShortcut.register(accelerator, () => {
                if (!sender.isDestroyed()) sender.send(CHANNELS.callHotkey, which);
            });
        } catch {
            ok = false;
        }
        if (!ok) continue;
        held.push(accelerator);
        result[which] = true;
    }
    holder = sender;
    // A window that closes or loads another page mid-call leaves nobody to hear.
    const letGo = () => {
        if (holder === sender) release();
    };
    sender.once("destroyed", letGo);
    sender.once("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) letGo();
    });
    return result;
}

/**
 * Whether the page in `contents` is in a call: it took the call's keys and has
 * not let them go. The page asks for them for the whole of every call, with or
 * without bindings, so this is the app's one reading of "a call is on here".
 */
export function holdsCall(contents: WebContents): boolean {
    return holder === contents && !contents.isDestroyed();
}

/** Let every key go, as the app quits. */
export function releaseCallHotkeys(): void {
    release();
}
