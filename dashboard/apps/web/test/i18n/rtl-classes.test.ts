/**
 * The interface mirrors in a right-to-left language because its classes name
 * the start and end of the line, not the left and right of the screen.
 *
 * `scripts/rtl-logical.mjs` rewrote the physical classes and names the files
 * where left and right are the picture's (canvases, video, maps, charts). This
 * runs its detection over every file in scope: a new `ml-2`, `text-left` or
 * `rounded-r` outside those files fails here, and `node scripts/rtl-logical.mjs`
 * fixes it.
 *
 * `scripts/rtl-physical.json` is what was left when this rule came in. It only
 * shrinks: a file with more than its count fails, and so does one with fewer,
 * so fixing one means lowering or removing its line.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
    BASELINE,
    EXCLUDED,
    ROOT,
    isExcluded,
    physicalClasses,
    rewriteClassList,
    rewriteSource
} from "../../scripts/rtl-logical.mjs";

const rewrite = (classes: string): string => rewriteClassList(classes).text;

describe("the logical-class codemod", () => {
    it("turns sides into start and end", () => {
        expect(rewrite("ml-2 mr-auto pl-3 pr-1.5 -ml-px")).toBe("ms-2 me-auto ps-3 pe-1.5 -ms-px");
        expect(rewrite("absolute left-2.5 right-0 -right-1")).toBe("absolute start-2.5 end-0 -end-1");
        expect(rewrite("text-left md:text-right")).toBe("text-start md:text-end");
        expect(rewrite("scroll-ml-4 scroll-pr-2 float-left clear-right")).toBe(
            "scroll-ms-4 scroll-pe-2 float-start clear-end"
        );
    });

    it("turns corners and borders, keeping their size and colour", () => {
        expect(rewrite("rounded-l rounded-r-xl rounded-tl-none rounded-br-sm")).toBe(
            "rounded-s rounded-e-xl rounded-ss-none rounded-ee-sm"
        );
        expect(rewrite("border-l border-r-2 border-l-primary/40 border-r-[3px]")).toBe(
            "border-s border-e-2 border-s-primary/40 border-e-[3px]"
        );
    });

    it("keeps variants, arbitrary selectors and the important mark", () => {
        expect(rewrite("hover:!pl-2 data-[state=open]:mr-1 [&_ul]:pl-6")).toBe(
            "hover:!ps-2 data-[state=open]:me-1 [&_ul]:ps-6"
        );
    });

    it("gives space-x and divide-x their reverse instead of a logical name", () => {
        expect(rewrite("flex -space-x-2")).toBe("flex -space-x-2 rtl:space-x-reverse");
        expect(rewrite("flex divide-x sm:space-x-1")).toBe(
            "flex divide-x sm:space-x-1 rtl:divide-x-reverse sm:rtl:space-x-reverse"
        );
        expect(rewrite("flex space-x-2 space-x-reverse")).toBe("flex space-x-2 space-x-reverse");
    });

    it("leaves centring, and lists that move on the x axis, physical", () => {
        expect(rewrite("absolute left-1/2 -translate-x-1/2")).toBe("absolute left-1/2 -translate-x-1/2");
        expect(rewrite("right-0 left-auto translate-x-0 rounded-l-xl border-r-0")).toBe(
            "right-0 left-auto translate-x-0 rounded-l-xl border-r-0"
        );
    });

    it("leaves what only looks like a class alone", () => {
        expect(rewrite("right-click to open")).toBe("right-click to open");
        expect(rewrite("rounded-lg border-red-500 pl pl-PL left")).toBe("rounded-lg border-red-500 pl pl-PL left");
    });

    it("reads string literals only, and never half a template", () => {
        const source = [
            'import x from "./ml-2";',
            "const a = <div className=\"ml-2\">ml-2 is prose</div>;",
            "const b = `pl-4 ${size} mr-2${x}`;"
        ].join("\n");
        expect(rewriteSource(source).source).toBe(
            [
                'import x from "./ml-2";',
                "const a = <div className=\"ms-2\">ml-2 is prose</div>;",
                "const b = `ps-4 ${size} mr-2${x}`;"
            ].join("\n")
        );
    });
});

describe("physical-direction classes", () => {
    it("names only exclusions that exist", () => {
        for (const { path, reason } of EXCLUDED) {
            expect(reason.length, path).toBeGreaterThan(0);
            if (!path.includes("*")) expect(existsSync(join(ROOT, path)), path).toBe(true);
        }
        expect(isExcluded("apps/places/src/screens/cameras/cameras-view.tsx")).toBe(true);
        expect(isExcluded("apps/web/src/components/avatar.tsx")).toBe(false);
    });

    it("appear in no file outside the exclusions beyond the baseline", () => {
        const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;
        expect(physicalClasses()).toEqual(baseline);
    }, 120_000);
});
