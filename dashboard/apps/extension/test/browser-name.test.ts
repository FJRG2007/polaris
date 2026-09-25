/**
 * Which Chromium browser the extension says it is, for the row the dashboard's
 * session list draws for it.
 *
 * Brave is the case that was wrong: its user agent says Chrome on purpose and
 * its own check is not reachable from the service worker, so only the brand
 * list tells it apart.
 */

import { describe, expect, it } from "vitest";
import { chromiumBrowser } from "../src/lib/browser-name";

const CHROME_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const brands = (...names: string[]) => names.map((brand) => ({ brand }));

describe("the browser a chrome build is running in", () => {
    it("names Brave from its brand, though its user agent says Chrome", () => {
        expect(chromiumBrowser(brands("Chromium", "Brave", "Not.A/Brand"), CHROME_AGENT)).toBe("Brave");
    });

    it("names Edge, Opera and Vivaldi", () => {
        expect(chromiumBrowser(brands("Chromium", "Microsoft Edge"), CHROME_AGENT)).toBe("Edge");
        expect(chromiumBrowser(brands("Chromium", "Opera"), CHROME_AGENT)).toBe("Opera");
        expect(chromiumBrowser([], `${CHROME_AGENT} Vivaldi/7.0`)).toBe("Vivaldi");
    });

    it("is Chrome when nothing more specific is said", () => {
        expect(chromiumBrowser(brands("Chromium", "Google Chrome", "Not.A/Brand"), CHROME_AGENT)).toBe(
            "Chrome"
        );
        expect(chromiumBrowser([], CHROME_AGENT)).toBe("Chrome");
    });
});
