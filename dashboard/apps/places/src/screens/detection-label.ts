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

import type { PlacesTranslator } from "../lib/i18n";
import { englishPlaces } from "../../messages";

/** A class a camera can report, in the words the house uses for it; anything
 *  else - a name - as it came. */
export function kindLabel(label: string, t: PlacesTranslator = englishPlaces): string {
    const key = `detection.kinds.${label}`;
    return t.has(key) ? t(key) : label;
}

/**
 * The line on a live box.
 *
 * The score is on it because a live view is the one place it is actionable: a
 * rectangle at forty percent is the detector being unsure, and somebody watching
 * their own camera deserves to see the difference rather than be shown a
 * confident-looking box around a bush.
 */
export function boxLabel(label: string, score: number, t: PlacesTranslator = englishPlaces): string {
    const said = kindLabel(label, t);
    return score > 0 ? t("detection.box", { label: said, score }) : said;
}
