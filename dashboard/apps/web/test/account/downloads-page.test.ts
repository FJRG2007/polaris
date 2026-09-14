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

describe("when nothing has been published", () => {
    it("says so, and says where it will appear", async () => {
        const source = await files;
        expect(source).toContain(
            "No version has been published yet. The files appear here, one per browser, as soon as one is."
        );
    });

    it("no longer sends the reader to the repository to build it", async () => {
        const source = await files;
        expect(source).not.toContain("It is built from this repository");
    });

    it("offers no button that cannot be pressed", async () => {
        // A disabled Download implies a file that is nearly ready. There is no
        // file, and the sentence above says exactly that instead.
        const source = await page;
        expect(source).not.toContain("Get it from the store");
        expect(source).not.toContain("<Button");
    });
});

describe("loading it by hand", () => {
    it("is steps, one list per browser", async () => {
        const source = await page;
        expect(source).toContain("function LoadSteps(");
        expect(source).toContain('browser="Chrome, Edge, Brave, Opera"');
        expect(source).toContain('browser="Firefox"');
        expect(source).toContain('"Open chrome://extensions"');
        expect(source).toContain('"Open about:debugging"');
    });

    it("still says what loading it that way costs", async () => {
        const source = await page;
        expect(source).toContain("does not update itself");
    });
});

describe("when there is a version", () => {
    it("names it, and links what changed in it", async () => {
        const source = await files;
        expect(source).toContain("<Badge variant=\"neutral\">{download.version}</Badge>");
        expect(source).toContain("What changed");
    });
});
