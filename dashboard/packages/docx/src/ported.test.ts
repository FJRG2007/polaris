/**
 * That the engine works here, rather than merely compiles here.
 *
 * Forty thousand lines came across from another project (GenOffice,
 * Apache-2.0) and arrived without their tests. What matters is not that every
 * corner of OOXML still behaves - that was true where it came from and nothing
 * in the port touches the logic - but that the port itself is whole: that the
 * package resolves, that the parts it needs from its sibling are reachable, and
 * that a document written by it can be read back by it.
 *
 * A round trip is the one assertion worth making here. It exercises the zip, the
 * XML writer, the XML reader and the block model in one go, and it is exactly
 * what a broken port fails.
 */

import JSZip from "jszip";
import { parseDocx } from "./parse";
import { buildBlankDocx } from "./blank";
import { describe, expect, it } from "vitest";

describe("a document this engine wrote", () => {
    it("is a real Office package", async () => {
        const bytes = await buildBlankDocx();
        expect(bytes.length).toBeGreaterThan(0);

        const zip = await JSZip.loadAsync(bytes);
        // The three parts every reader looks for first. A file missing any of
        // them opens as "corrupt" with nothing to say which one was wrong.
        expect(zip.file("[Content_Types].xml")).toBeTruthy();
        expect(zip.file("_rels/.rels")).toBeTruthy();
        expect(zip.file("word/document.xml")).toBeTruthy();
    });

    it("reads back through its own parser", async () => {
        // The round trip: zip, XML writer, XML reader and block model, in one
        // assertion. What a broken port fails.
        const parsed = await parseDocx(await buildBlankDocx());
        expect(parsed).toBeTruthy();
        expect(Array.isArray(parsed.blocks)).toBe(true);
    });

    it("brings its sibling's geometry reader with it", async () => {
        // The one cross-package import in the port. It resolves through the
        // built package rather than through a path, so a wrong subpath export
        // fails here rather than at the first shape somebody draws.
        const { parseCustGeom } = await import("@polaris/pptx/custgeom");
        expect(typeof parseCustGeom).toBe("function");
    });
});
