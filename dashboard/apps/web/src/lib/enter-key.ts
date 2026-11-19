/**
 * What Enter means in a box where it can send.
 *
 * On a computer Enter sends and shift+Enter breaks the line. A phone has no
 * shift to hold with Enter, so a box that sends on Enter there is a box nobody
 * can write two lines in - WhatsApp, Telegram and Signal all break the line on
 * a phone's Enter key and send from the button. A tablet with a keyboard and a
 * trackpad answers to `any-pointer: fine`, so it keeps the computer's keys.
 */
export function enterBreaksLine(): boolean {
    return onScreenKeyboard();
}

/**
 * Whether this device types on an on-screen keyboard: touch only, with no
 * mouse or trackpad beside it. Phones and tablets without a keyboard.
 *
 * Also what decides that Polaris's own dictation is not offered: every phone
 * keyboard - Gboard, Samsung's, Apple's, SwiftKey - has a microphone key of
 * its own, so a second one in the box is a button that does what the keyboard
 * already does. A web page cannot ask the keyboard what it can do, and the
 * keyboard's own key is what people there reach for.
 */
export function onScreenKeyboard(): boolean {
    if (typeof matchMedia !== "function") return false;
    return matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
}

/** The label the on-screen keyboard puts on its Enter key for such a box. */
export function enterKeyHint(): "enter" | "send" {
    return enterBreaksLine() ? "enter" : "send";
}
