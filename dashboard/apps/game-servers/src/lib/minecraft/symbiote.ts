/**
 * Symbiote, a mod Polaris carries for the operator: where it runs, and the edits
 * that put it on a server's list and take it off.
 *
 * It is built into the dashboard image from `resources/minecraft/symbiote` and
 * served from the server's own pack link (`client-pack`), never from the public
 * mod route: the server downloads it through `MODS` at that address, and players
 * get the same jar from the same link when they run the mod pack's line. It runs
 * on both sides, so every player needs it in their own game.
 *
 * It declares the one release it was built for, and the loader ends the boot of
 * any other over it, so it is offered there and nowhere else - and a server that
 * moves off that release takes it off its list (`symbioteMovedTo`).
 *
 * Pure: nothing here reads or writes a server.
 */

import { loaderForType } from "./modrinth";
import { MODS_KEY, carriesFile, modEntries } from "./polaris-login";

/** The file the dashboard serves it as. */
export const SYMBIOTE_FILE = "symbiote-neoforge-1.21.4.jar";

/** Every file of it the dashboard serves, for the route. */
export const SYMBIOTE_FILES: readonly string[] = [SYMBIOTE_FILE];

/** The one release it loads on. */
export const SYMBIOTE_RELEASE = "1.21.4";

/** Whether it runs on a server, or which half of the server rules it out. */
export type SymbioteFit = "fits" | "loader" | "release";

export function symbioteFit(software: string, version: string): SymbioteFit {
    if (loaderForType(software) !== "neoforge") return "loader";
    return version.trim() === SYMBIOTE_RELEASE ? "fits" : "release";
}

/** Whether the list carries it, whichever address it was written with. */
export function hasSymbiote(mods: string): boolean {
    return carriesFile(mods, SYMBIOTE_FILE);
}

/** The list without it. Empty is a real value: the image only removes what the
 *  list dropped when the list is set. */
export function withoutSymbiote(mods: string): string {
    return modEntries(mods)
        .filter((entry) => !carriesFile(entry, SYMBIOTE_FILE))
        .join(",");
}

/** The list with it, once, at `url` - the server's pack link for the jar. */
export function withSymbiote(mods: string, url: string): string {
    return [...modEntries(withoutSymbiote(mods)), url].join(",");
}

/** Whether the list carries it at an address other than `url`: one written
 *  before it moved behind the pack link, which the public route no longer
 *  answers, so a server booting with it would not start. */
export function symbioteElsewhere(mods: string, url: string): boolean {
    return hasSymbiote(mods) && !modEntries(mods).includes(url);
}

/**
 * What a server moving to this software and release has to write for it, or
 * null when nothing: it is not on the list, or it still runs there. Kept on the
 * list it would end the new release's boot.
 */
export function symbioteMovedTo(
    software: string,
    version: string,
    mods: string
): Map<string, string> | null {
    if (!hasSymbiote(mods) || symbioteFit(software, version) === "fits") return null;
    return new Map([[MODS_KEY, withoutSymbiote(mods)]]);
}
