/**
 * What a connected client's name says it is running in.
 *
 * A vault client has no user agent. A browser session arrives with one and the
 * session table splits it into a browser and a system; a client arrives with a
 * single string it chose for itself, and until that string was parsed the only
 * thing a row could show was the string. That is why a person running Brave saw
 * "Chrome extension" - the extension named itself after the build target rather
 * than after the browser it was in.
 *
 * So the client reports "Brave on Windows" and this reads it back apart. The
 * name is still a claim, exactly as the session table's device label is, and
 * nothing here is used to decide anything: it picks which mark to draw and which
 * two columns to fill.
 *
 * The rule for splitting is deliberately strict. A name is only treated as two
 * halves when the right-hand one is a system this UI actually knows, so a client
 * somebody called "the laptop on the shelf" stays one name instead of being read
 * as a browser called "the laptop" on a system called "the shelf".
 */

import type { VaultClientKind } from "@polaris/core";

export interface ClientDevice {
    /** The browser, or the whole name when it does not name one. */
    readonly browser: string;
    /** The system, when the name gave one that this UI can draw. */
    readonly os: string | null;
}

/**
 * The browsers a mark exists for, in the spelling `BrowserMark` matches on.
 *
 * Kept as the canonical spelling rather than lowercased, because matching is what
 * this list is for and the answer has to come back in the form the mark expects -
 * a row that reports "brave" should still get Brave's logo.
 */
const BROWSERS = ["Brave", "Chrome", "Firefox", "Safari", "Edge", "Opera", "Vivaldi"] as const;

/** The systems a mark exists for, in the spelling `SystemMark` matches on. */
const SYSTEMS = ["Windows", "macOS", "iOS", "Linux", "Android"] as const;

/** The canonical spelling of a browser name, or null when it names none. */
function knownBrowser(text: string): string | null {
    // "Chrome extension" and "Firefox extension" are what older builds of the
    // extension called themselves, and what several other vault clients call
    // themselves too. The word adds nothing to a column already headed App.
    const said = text.trim().replace(/\s+extension$/i, "");
    return BROWSERS.find((browser) => browser.toLowerCase() === said.toLowerCase()) ?? null;
}

/** The canonical spelling of a system name, or null when it names none. */
function knownSystem(text: string): string | null {
    const said = text.trim();
    return SYSTEMS.find((os) => os.toLowerCase() === said.toLowerCase()) ?? null;
}

/**
 * Read a client's name as a browser and a system.
 *
 * Never throws and never comes back empty: whatever cannot be recognised is
 * handed back as the browser, because a row showing an unfamiliar name is still
 * a row somebody can account for, and a blank one is not.
 */
export function readClientDevice(name: string): ClientDevice {
    const said = name.trim();
    if (said === "") return { browser: "Unknown device", os: null };

    // The last " on ", not the first: a client named "Chrome on the desk on
    // Windows" is on Windows, and the rest is what it is called.
    const at = said.toLowerCase().lastIndexOf(" on ");
    if (at > 0) {
        const left = said.slice(0, at).trim();
        const os = knownSystem(said.slice(at + " on ".length));
        // Only when the right half is a system this UI knows. Anything else and
        // the name was never two halves to begin with.
        if (os !== null && left !== "") return { browser: knownBrowser(left) ?? left, os };
    }
    return { browser: knownBrowser(said) ?? said, os: null };
}

/**
 * What kind of thing a client is, in words rather than as a type number.
 *
 * The question somebody scanning this list has is "which of these is the browser
 * extension", so that is what the column says. The vendor is already in the
 * device column beside it, which is why this names the kind of client and never
 * whose - two different extensions can be signed in at once.
 */
export function clientKindLabel(kind: VaultClientKind): string {
    if (kind === "extension") return "Browser extension";
    if (kind === "browser") return "Web vault";
    if (kind === "mobile") return "Mobile app";
    if (kind === "desktop") return "Desktop app";
    if (kind === "cli") return "Command line";
    return "App";
}
