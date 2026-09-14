/**
 * The page that says how to have Polaris somewhere other than this tab.
 *
 * Two things were wrong with it, and both were about what it says when there is
 * nothing to download yet.
 *
 * **It read as an instruction to go and compile something.** "It is built from
 * this repository and released on a tag of its own" is true and is no use to the
 * person reading it: this is a product whose whole premise is that nobody opens
 * a terminal. What somebody needs to know is that no version is out and that the
 * files will be here when one is.
 *
 * **And the instructions for loading it were one paragraph with four steps in
 * it, twice.** Somebody following those is in another window, holding their
 * place in a sentence. They are steps, so they are drawn as steps.
 *
 * The disabled store button went with them: a button that cannot be pressed
 * implies a file that is nearly ready, which is a different and untrue claim.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const page = readFile(`${SRC}app/(app)/account/downloads/page.tsx`, "utf8");
const files = readFile(`${SRC}components/app-download.tsx`, "utf8");

/**
 * The file with its line wrapping taken out.
 *
 * A sentence written in JSX is broken across lines by the formatter, so asking
 * the raw file whether it still contains one passes for the wrong reason - the
 * words are all there, only not adjacent. That is exactly how the sentence below
 * survived a test written to see it gone, so every assertion about prose here
 * goes through this.
 */
const flat = (source: string) => source.replace(/\s+/g, " ");

describe("when nothing has been published", () => {
    it("says so, and says where it will appear", async () => {
        const source = flat(await files);
        expect(source).toContain(
            "No version has been published yet. The files appear here, one per browser, as soon as one is."
        );
        expect(source).toContain(
            "No version has been published yet. Installing Polaris as an app above"
        );
    });

    it("no longer sends the reader to the repository to build it", async () => {
        // Said in two places, and only one of them was the download centre: the
        // offer drawn on the preferences and clients screens carried the same
        // instruction to go and build it from a checkout.
        expect(flat(await files)).not.toContain("It is built from this repository");
    });

    it("offers no button that cannot be pressed", async () => {
        // A disabled Download implies a file that is nearly ready. There is no
        // file, and the sentence above says exactly that instead.
        const source = flat(await page);
        expect(source).not.toContain("Get it from the store");
        expect(source).not.toContain("<Button");
    });
});

describe("loading it by hand", () => {
    it("is a guided sequence, not a paragraph with the steps inside it", async () => {
        const source = await page;
        expect(source).toContain("<ExtensionSteps />");
    });

    it("no longer writes one browser's steps into the page itself", async () => {
        // They moved into `browser-guide`, where which file and which address
        // each browser takes can be asserted. `extension-steps` covers the rest.
        const source = await page;
        expect(source).not.toContain("function LoadSteps(");
        expect(source).not.toContain('browser="Chrome, Edge, Brave, Opera"');
    });
});

describe("when there is a version", () => {
    it("names it, and links what changed in it", async () => {
        const source = await files;
        expect(source).toContain("<Badge variant=\"neutral\">{download.version}</Badge>");
        expect(source).toContain("What changed");
    });
});
