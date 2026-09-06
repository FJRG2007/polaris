"use client";

/**
 * Which way round your own picture is drawn.
 *
 * Only your own, and only for you. A camera pointed at a face sends a picture
 * that is the right way round for everybody watching it and the wrong way round
 * for the person in it: they have spent their life seeing themselves in mirrors,
 * so unmirrored their own tile reads as somebody else wearing their face, and
 * every gesture goes the wrong way. Every call client mirrors the local preview
 * for that reason and none of them mirror what is sent - flipping the picture
 * other people receive would turn the writing on your shirt backwards for them.
 *
 * The default is worked out from the camera rather than asked for. A laptop
 * webcam and a phone's selfie camera face the person and are mirrored; a phone's
 * rear camera is pointed at the world, where a mirrored picture is simply wrong -
 * a road sign in it would read backwards. `facingMode` is what says which,
 * reported by every browser that has more than one camera to report about, and
 * absent on a desktop - where "a camera facing the person" is the only kind
 * there is.
 *
 * The choice can still be made by hand, because the guess has one honest gap: a
 * capture card, a document camera, or a webcam somebody has pointed at their
 * desk all report nothing and all get mirrored. Remembered per browser, like the
 * volumes and the microphone cleanup, because it is a fact about the machine on
 * the desk rather than about the person.
 */

const KEY = "polaris.call.mirror";

/** What the reader has said about it, or `auto` where they never have. */
export type MirrorChoice = "auto" | "on" | "off";

/**
 * Whether a camera faces the person holding it.
 *
 * `environment` is the only answer that means "no" - `user`, an empty string and
 * nothing at all are all a camera pointed at a face, which is what a desktop
 * webcam is and what a browser that reports nothing is most likely to be on.
 */
export function facesTheReader(facingMode: string | null | undefined): boolean {
    return facingMode !== "environment";
}

/** Whether to draw your own tile mirrored, given what you asked for and what the
 *  camera says it is. */
export function mirrorsPicture(choice: MirrorChoice, facingMode: string | null | undefined): boolean {
    if (choice === "on") return true;
    if (choice === "off") return false;
    return facesTheReader(facingMode);
}

export function mirrorChoice(): MirrorChoice {
    if (typeof window === "undefined") return "auto";
    try {
        const held = window.localStorage.getItem(KEY);
        return held === "on" || held === "off" ? held : "auto";
    } catch {
        // Storage refused - a browser with it disabled, or a full quota.
        return "auto";
    }
}

export function setMirrorChoice(choice: MirrorChoice): void {
    if (typeof window === "undefined") return;
    try {
        if (choice === "auto") window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, choice);
    } catch {
        // It still applies to this call; it just will not be remembered.
    }
}
