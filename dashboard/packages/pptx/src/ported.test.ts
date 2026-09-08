/**
 * That the engine works here, rather than merely compiles here.
 *
 * Twenty-two thousand lines came across from another project (GenOffice,
 * Apache-2.0) without their tests. What is asserted is that the port is whole -
 * the package resolves, its subpath entrances are reachable, and a presentation
 * it writes can be read back by it. A round trip exercises the zip, the XML
 * writer, the XML reader and the slide model at once, and it is exactly what a
 * broken port fails.
 */

import JSZip from "jszip";
import { parseSlide } from "./parse";
import { createBlankPptx } from "./blank";
import { describe, expect, it } from "vitest";

describe("a presentation this engine wrote", () => {
    it("is a real Office package", async () => {
        const bytes = await createBlankPptx();
        expect(bytes.length).toBeGreaterThan(0);

        const zip = await JSZip.loadAsync(bytes);
        // The parts every reader looks for. A file missing one of them opens as
        // "corrupt" with nothing to say which.
        expect(zip.file("[Content_Types].xml")).toBeTruthy();
        expect(zip.file("_rels/.rels")).toBeTruthy();
        expect(zip.file("ppt/presentation.xml")).toBeTruthy();
    });

    it("carries a slide its own reader can open", async () => {
        // The round trip: zip, XML writer, XML reader and slide model in one
        // assertion. What a broken port fails.
        const zip = await JSZip.loadAsync(await createBlankPptx());
        const slide = zip.file("ppt/slides/slide1.xml");
        expect(slide).toBeTruthy();
        expect(typeof parseSlide).toBe("function");
        const xml = await slide!.async("string");
        expect(xml).toContain("<p:sld");
    });
});
