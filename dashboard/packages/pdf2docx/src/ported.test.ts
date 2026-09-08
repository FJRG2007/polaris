/**
 * That the port is whole.
 *
 * Nineteen thousand lines came across from another project (GenOffice,
 * Apache-2.0) without their tests, and this one has the most edges of any of
 * them: it reaches into three sibling packages, and in its own repository it
 * reached into them by path. Those paths do not exist here, so what is asserted
 * is that every one of them now resolves through a package - which is the exact
 * failure a port like this has, and one nothing would notice until somebody
 * converted a PDF.
 */

import { describe, expect, it } from "vitest";

describe("the packages this one is built on", () => {
    it("reaches the document engine by name rather than by path", async () => {
        const docx = await import("@polaris/docx");
        expect(typeof docx.buildBlankDocx).toBe("function");
    });

    it("reaches the presentation engine", async () => {
        const pptx = await import("@polaris/pptx");
        expect(typeof pptx.createBlankPptx).toBe("function");
    });

    it("reaches the font metrics", async () => {
        const metrics = await import("@polaris/font-metrics");
        expect(typeof metrics.advanceWidths).toBe("function");
    });
});

describe("its own entrance", () => {
    it("loads, which means every module under it loaded too", async () => {
        // The cheapest whole-port assertion there is: an index that imports
        // nineteen thousand lines fails to evaluate if any one of them has an
        // import that does not resolve.
        const entry = await import("./index");
        expect(entry).toBeTruthy();
        expect(Object.keys(entry).length).toBeGreaterThan(0);
    });
});
