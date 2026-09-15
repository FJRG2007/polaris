/**
 * Reading a connected client's name as a browser and a system.
 *
 * The case this exists for is the one somebody reported: running Brave and being
 * shown "Chrome extension", because the extension named itself after the build
 * target. The name now says which browser it is in, and this is what puts the two
 * halves in the two columns.
 *
 * The other half of the job is knowing when NOT to split. A client's name is
 * whatever its owner typed, so the rule has to be narrow enough that an ordinary
 * sentence is left alone rather than being read as a browser and a system.
 */

import { describe, expect, it } from "vitest";
import { clientKindLabel, readClientDevice } from "../../src/lib/vault/client-device";

describe("reading what a client is running in", () => {
    it("splits the browser from the system", () => {
        expect(readClientDevice("Brave on Windows")).toEqual({
            browser: "Brave",
            os: "Windows",
            known: true
        });
    });

    it("keeps the spelling the marks match on", () => {
        // The mark is chosen by an exact string, so a client that shouts its own
        // name still has to come back as "Brave" or it gets the neutral globe.
        expect(readClientDevice("BRAVE on WINDOWS")).toEqual({
            browser: "Brave",
            os: "Windows",
            known: true
        });
        expect(readClientDevice("brave on macos")).toEqual({
            browser: "Brave",
            os: "macOS",
            known: true
        });
    });

    it("drops the word extension, which the column above already says", () => {
        expect(readClientDevice("Chrome extension")).toEqual({
            browser: "Chrome",
            os: null,
            known: true
        });
        expect(readClientDevice("Firefox extension on Linux")).toEqual({
            browser: "Firefox",
            os: "Linux",
            known: true
        });
    });

    it("leaves a name that is not two halves alone", () => {
        // The rule that stops "the laptop on the shelf" being read as a browser
        // called "the laptop" running on a system called "the shelf".
        expect(readClientDevice("the laptop on the shelf")).toEqual({
            browser: "the laptop on the shelf",
            os: null,
            known: false
        });
    });

    it("takes the last system, not the first thing that looks like one", () => {
        expect(readClientDevice("Chrome on the desk on Windows")).toEqual({
            browser: "Chrome on the desk",
            os: "Windows",
            known: false
        });
    });

    it("hands back an unfamiliar name rather than hiding it", () => {
        // A row somebody cannot account for is the entire point of the list, so an
        // unknown client has to show the name it reported.
        expect(readClientDevice("Bitwarden CLI")).toEqual({
            browser: "Bitwarden CLI",
            os: null,
            known: false
        });
    });

    it("says when the name was not a browser at all", () => {
        // What the row draws hangs off this. Every unrecognised name comes back
        // from `BrowserMark` as the same neutral globe, so a row whose name is not
        // a browser is marked by what kind of client it said it was instead - and
        // this is the only thing that can tell the two cases apart.
        expect(readClientDevice("Firefox").known).toBe(true);
        expect(readClientDevice("Polaris CLI").known).toBe(false);
        expect(readClientDevice("iPhone on iOS").known).toBe(false);
    });

    it("never comes back empty", () => {
        expect(readClientDevice("")).toEqual({
            browser: "Unknown device",
            os: null,
            known: false
        });
        expect(readClientDevice("   ")).toEqual({
            browser: "Unknown device",
            os: null,
            known: false
        });
    });

    it("does not split on a leading or trailing on", () => {
        expect(readClientDevice("on Windows").os).toBeNull();
        expect(readClientDevice("Chrome on ")).toEqual({
            browser: "Chrome on",
            os: null,
            known: false
        });
    });
});

describe("what kind of client a row is", () => {
    it("names the extension the way somebody scanning the list would", () => {
        expect(clientKindLabel("extension")).toBe("Browser extension");
    });

    it("tells a browser apart from an extension running inside one", () => {
        expect(clientKindLabel("browser")).not.toBe(clientKindLabel("extension"));
    });

    it("has words for every kind", () => {
        for (const kind of ["extension", "browser", "mobile", "desktop", "cli", "other"] as const) {
            expect(clientKindLabel(kind)).not.toBe("");
        }
    });
});
