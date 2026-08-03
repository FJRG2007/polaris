/**
 * Reading what a browser says it is, and deciding whether a client may present a
 * credential.
 *
 * The cases worth pinning are the ones where a plain user-agent read gives the
 * wrong answer: a Chromium browser that reports itself as Chrome on purpose, an
 * Android that also says Linux, an iPad that also says Mac. And, for the API-key
 * lists, that a space in a pattern is a space rather than a wildcard - that one
 * would silently widen every rule anybody wrote.
 */

import { describe, expect, it } from "vitest";
import { describeClient, describeDevice, userAgentAllowed, userAgentMatches } from "../src/user-agent.js";

const CHROME_WINDOWS =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IPAD =
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const CHROME_ANDROID =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

describe("describeClient", () => {
    it("reads the browser and system out of a user-agent", () => {
        expect(describeClient(CHROME_WINDOWS)).toEqual({
            browser: "Chrome",
            os: "Windows",
            label: "Chrome on Windows"
        });
    });

    it("names the browser the user-agent hides, from the client hints", () => {
        // Brave reports itself as Chrome on purpose; the hints are the only place
        // it says otherwise, which is the whole reason they are recorded.
        const brands = '"Chromium";v="131", "Brave";v="131", "Not.A/Brand";v="99"';
        expect(describeClient(CHROME_WINDOWS, brands).browser).toBe("Brave");
    });

    it("ignores the padding brands every Chromium sends", () => {
        const brands = '"Not_A Brand";v="24", "Chromium";v="131", "Google Chrome";v="131"';
        expect(describeClient(CHROME_WINDOWS, brands).browser).toBe("Chrome");
    });

    it("falls back to the user-agent when the hints name nothing real", () => {
        expect(describeClient(FIREFOX_LINUX, '"Not_A Brand";v="24"').browser).toBe("Firefox");
    });

    it("prefers the narrower system claim", () => {
        // Android says Linux and an iPad says Mac; reading them in the other order
        // would file a phone under desktop Linux.
        expect(describeClient(CHROME_ANDROID).os).toBe("Android");
        expect(describeClient(SAFARI_IPAD).os).toBe("iOS");
        expect(describeClient(FIREFOX_LINUX).os).toBe("Linux");
    });

    it("says so plainly when nothing was recorded", () => {
        expect(describeDevice(null)).toBe("Unknown device");
        expect(describeDevice(undefined, '"Brave";v="131"')).toBe("Unknown device");
    });
});

describe("userAgentMatches", () => {
    it("matches anywhere in the client, ignoring case", () => {
        expect(userAgentMatches("curl/8.4.0", "curl")).toBe(true);
        expect(userAgentMatches(CHROME_WINDOWS, "chrome/131")).toBe(true);
        expect(userAgentMatches(CHROME_WINDOWS, "curl")).toBe(false);
    });

    it("treats * as any run of characters", () => {
        expect(userAgentMatches(CHROME_WINDOWS, "Chrome/1*.0")).toBe(true);
        expect(userAgentMatches("curl/8.4.0", "Chrome/1*.0")).toBe(false);
    });

    it("treats a space as a space, not a wildcard", () => {
        // A user-agent is mostly spaces. Reading them as wildcards would quietly
        // widen every rule anybody wrote.
        expect(userAgentMatches(CHROME_WINDOWS, "like Gecko")).toBe(true);
        expect(userAgentMatches(CHROME_WINDOWS, "Windows x64")).toBe(false);
    });

    it("takes the rest of a pattern literally", () => {
        expect(userAgentMatches("Deploy/1.0", "Deploy/1.0")).toBe(true);
        // A dot is a dot: it must not stand for any character.
        expect(userAgentMatches("Deploy/1x0", "Deploy/1.0")).toBe(false);
    });

    it("matches nothing on an empty pattern", () => {
        expect(userAgentMatches(CHROME_WINDOWS, "   ")).toBe(false);
    });
});

describe("userAgentAllowed", () => {
    const none = { allowedUserAgents: [], deniedUserAgents: [] };

    it("allows any client when no list was set", () => {
        expect(userAgentAllowed(none, CHROME_WINDOWS)).toBe(true);
        expect(userAgentAllowed(none, null)).toBe(true);
    });

    it("admits only the listed clients once a list exists", () => {
        const rules = { allowedUserAgents: ["curl"], deniedUserAgents: [] };
        expect(userAgentAllowed(rules, "curl/8.4.0")).toBe(true);
        expect(userAgentAllowed(rules, CHROME_WINDOWS)).toBe(false);
        // Nothing to match against is not a match.
        expect(userAgentAllowed(rules, null)).toBe(false);
    });

    it("lets a denial win over the allow list", () => {
        const rules = { allowedUserAgents: ["Mozilla"], deniedUserAgents: ["Chrome/131"] };
        expect(userAgentAllowed(rules, CHROME_WINDOWS)).toBe(false);
        expect(userAgentAllowed(rules, FIREFOX_LINUX)).toBe(true);
    });
});
