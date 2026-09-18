/**
 * What to write on a detection, wherever it is drawn.
 *
 * Four screens say this now - the events list, a wall tile, a camera opened
 * big, and a recording being played back - and they have to say it the same way
 * or the same arrival reads as four different things.
 *
 * What arrives from a detector is either a class it recognized ("person") or the
 * name of somebody it knows ("Ana"). Only the first is ours to translate: a name
 * is a name and is written down exactly as the person who added it typed it.
 */

/** The classes a camera can report, in the words the house uses for them. */
export const KIND_LABEL: Readonly<Record<string, string>> = {
    motion: "Movement",
    person: "Somebody",
    vehicle: "A vehicle",
    animal: "An animal",
    package: "A box or bag",
    face: "Recognized",
    tamper: "Camera tampered with",
    offline: "Camera went quiet"
};

/**
 * The line on a live box.
 *
 * The score is on it because a live view is the one place it is actionable: a
 * rectangle at forty percent is the detector being unsure, and somebody watching
 * their own camera deserves to see the difference rather than be shown a
 * confident-looking box around a bush.
 */
export function boxLabel(label: string, score: number): string {
    const said = KIND_LABEL[label] ?? label;
    return score > 0 ? `${said} ${score}%` : said;
}
