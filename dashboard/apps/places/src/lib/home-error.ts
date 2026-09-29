/**
 * A refusal written to be read.
 *
 * The difference between this and any other error is who it was written for. A
 * screen may show one of these word for word, because somebody chose the words;
 * anything else that reaches an action is a fault, and a fault's own words are
 * about columns and drivers. Putting those in front of the person adding a
 * camera tells them nothing they can act on and everything about the schema.
 *
 * Every deliberate refusal in Places throws one, and the actions show only
 * these. It is the same shape Chat and Tasks already use.
 *
 * The words are a catalog key (`refusal("errors.cameraNotFound")`), so the
 * action can say them in the reader's language; `message` is the English, for
 * the log. Importing nothing but the catalogs: a screen's test should be able
 * to ask what it would be shown without standing up a session and a database
 * first.
 */

import type { MessageParams, Translator } from "@polaris/core";
import { englishPlaces, type PlacesKey } from "../../messages";

/** The catalog key and values an error was worded with, when it was. Carried by
 *  a refusal and by a driver's or an integration's own errors, so a refusal
 *  passed up from one keeps its words. */
export interface Worded {
    readonly key?: PlacesKey;
    readonly params?: MessageParams;
}

export class HomeError extends Error implements Worded {
    public readonly key?: PlacesKey;
    public readonly params?: MessageParams;

    public constructor(message: string, worded: Worded = {}) {
        super(message);
        this.name = "HomeError";
        this.key = worded.key;
        this.params = worded.params;
    }
}

/** A refusal in the catalog's words. */
export function refusal(key: PlacesKey, params?: MessageParams): HomeError {
    return new HomeError(englishPlaces(key, params), { key, params });
}

/** The English of a key, for an error class that carries its words - the
 *  message of a driver's or an integration's refusal. */
export function worded(key: PlacesKey, params?: MessageParams): [string, Worded] {
    return [englishPlaces(key, params), { key, params }];
}

/** What an error says, in the reader's language when it was worded from the
 *  catalog, and as it came otherwise. */
export function sayIn(t: Translator<PlacesKey>, error: Error & Worded): string {
    return error.key ? t(error.key, error.params) : error.message;
}
