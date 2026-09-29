/**
 * The game servers app's server code carries its sentences as catalog keys (see
 * `lib/game-message`), and the screen or the action that shows one writes it in
 * the reader's language. A test that reads what the lib said reads it in English,
 * which is the words the assertions were written against.
 */

import { gameMessageIn } from "@polaris-app/game-servers/src/lib/game-message";

/** A carried message in English; any other text as it is. */
export function english(text: string): string;
export function english(text: string | null | undefined): string | null | undefined;
export function english(text: string | null | undefined): string | null | undefined {
    return typeof text === "string" ? gameMessageIn("en-US", text) : text;
}

/** What a promise rejected with, in English, or null when it did not reject. */
export async function rejection(work: Promise<unknown>): Promise<string | null> {
    try {
        await work;
        return null;
    } catch (caught) {
        return english(caught instanceof Error ? caught.message : String(caught));
    }
}

/** What a function threw, in English, or null when it did not throw. */
export function thrown(work: () => unknown): string | null {
    try {
        work();
        return null;
    } catch (caught) {
        return english(caught instanceof Error ? caught.message : String(caught));
    }
}
