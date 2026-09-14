/**
 * The guide behind the extension's install steps.
 *
 * Two things about it are easy to get subtly wrong and impossible to notice from
 * the page: which file a browser can actually load, and which address puts the
 * reader on the pane that loads it. Both are values somebody retypes in another
 * window, so both are pinned here.
 *
 * The third is Safari. Its user agent says Safari and not Chrome, it loads
 * neither package, and the tempting default - anything that is not Firefox is
 * Chromium - sends somebody to a menu their browser does not have.
 */

import { describe, expect, it } from "vitest";
import { BROWSER_GUIDES, browserGuide, detectBrowser } from "@/lib/browser-guide";

/** Real-shaped user agents, one per browser family the page has to tell apart. */
const AGENTS = {
    chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    opera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/127.0.0.0",
    brave: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0",
    firefoxIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/142.0 Mobile/15E148 Safari/605.1.15",
    safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
};

describe("which browser is reading", () => {
    it("puts the whole Chromium family on the same steps", () => {
        expect(detectBrowser(AGENTS.chrome)).toBe("chromium");
        expect(detectBrowser(AGENTS.edge)).toBe("chromium");
        expect(detectBrowser(AGENTS.opera)).toBe("chromium");
        expect(detectBrowser(AGENTS.brave)).toBe("chromium");
    });

    it("recognizes Firefox, including the one on iOS", () => {
        expect(detectBrowser(AGENTS.firefox)).toBe("firefox");
        expect(detectBrowser(AGENTS.firefoxIos)).toBe("firefox");
    });

    it("says nothing rather than guessing for a browser with no build", () => {
        // Safari's agent carries "Safari", and so does Chrome's - so the order
        // this asks in is the whole of whether this answer is right.
        expect(detectBrowser(AGENTS.safari)).toBeNull();
        expect(detectBrowser("")).toBeNull();
    });
});

describe("what each browser is told to do", () => {
    it("sends Chromium to a folder and Firefox to the file itself", () => {
        // Pointing Load unpacked at a .zip is the commonest way this fails, and
        // unpacking for Firefox is work that makes the add-on not load at all.
        expect(browserGuide("chromium").unpack).toBe(true);
        expect(browserGuide("firefox").unpack).toBe(false);
    });

    it("lands Firefox on the pane that can load one, not on about:debugging", () => {
        expect(browserGuide("firefox").page).toBe("about:debugging#/runtime/this-firefox");
    });

    it("names the control each browser actually has", () => {
        expect(browserGuide("chromium").action).toBe("Load unpacked");
        expect(browserGuide("firefox").action).toBe("Load Temporary Add-on");
    });

    it("takes the package built for it", () => {
        expect(browserGuide("chromium").file).toBe("chrome");
        expect(browserGuide("firefox").file).toBe("firefox");
    });

    it("says what this way of loading it costs, for both", () => {
        for (const guide of BROWSER_GUIDES) expect(guide.caveat.length).toBeGreaterThan(0);
        expect(browserGuide("firefox").caveat).toContain("when it closes");
    });
});
