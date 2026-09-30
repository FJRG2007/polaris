/**
 * How a Places action turns what went wrong into what the screen is told.
 *
 * Only a `HomeError` is shown, because only a `HomeError` was written to be
 * read. Everything else that lands here is a fault, and a fault's own words are
 * about columns, drivers and connection strings - a camera that would not save
 * once told whoever was adding it about a uuid column, which is a sentence that
 * helps nobody and describes the schema to anyone passing.
 *
 * The real one is not swallowed: it goes to the log, whole, where the operator
 * can find it and the person adding a camera does not have to read it.
 *
 * Its own module rather than a function in an actions file, because every
 * export of a `"use server"` module is an action anybody can call.
 *
 * Server-only.
 */

import { placesT } from "./i18n";
import { HomeError } from "./home-error";
import { placesRefusalText } from "./refusal-text";

export async function guard<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (caught) {
        const t = await placesT();
        if (caught instanceof HomeError) return { error: placesRefusalText(t, caught.message) };
        console.error("places: an action failed", caught);
        return { error: t("refusals.failed") };
    }
}
