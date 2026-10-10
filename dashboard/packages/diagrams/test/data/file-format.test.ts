// @vitest-environment jsdom

/**
 * Diagram files, libraries, clipboard payloads and SVG exports are recognized
 * by Polaris's own format identifiers, and by nothing else.
 */

import { describe, expect, it } from "vitest";
import {
    isValidDiagramData,
    isValidLibrary,
    serializeLibraryAsJSON
} from "../../src/editor/data/json";
import { decodeSvgBase64Payload } from "../../src/editor/scene/export";
import { stringToBase64, encode } from "../../src/editor/data/encode";
import { normalizeFile, getMimeType } from "../../src/editor/data/blob";
import { EXPORT_DATA_TYPES, MIME_TYPES } from "../../src/editor/constants";

/** An SVG export carrying a scene under the given payload type. */
function svgWith(payloadType: string, scene: object): string {
    const base64 = stringToBase64(JSON.stringify(encode({ text: JSON.stringify(scene) })), true);
    return `<svg><metadata><!-- payload-type:${payloadType} --><!-- payload-version:2 --><!-- payload-start -->${base64}<!-- payload-end --></metadata></svg>`;
}

describe("diagram file format", () => {
    it("accepts a scene saved under the diagram type only", () => {
        expect(isValidDiagramData({ type: EXPORT_DATA_TYPES.diagram, elements: [] })).toBe(true);
        expect(isValidDiagramData({ type: "something-else", elements: [] })).toBe(false);
        expect(isValidDiagramData(undefined)).toBe(false);
    });

    it("accepts a library saved under the library type only", () => {
        expect(
            isValidLibrary({ type: EXPORT_DATA_TYPES.diagramLibrary, version: 2, libraryItems: [] })
        ).toBe(true);
        expect(isValidLibrary({ type: "other", version: 2, libraryItems: [] })).toBe(false);
        expect(JSON.parse(serializeLibraryAsJSON([])).type).toBe(EXPORT_DATA_TYPES.diagramLibrary);
    });

    it("reads the scene from an SVG exported under the diagram MIME type only", () => {
        const scene = { type: EXPORT_DATA_TYPES.diagram, elements: [] };
        expect(
            JSON.parse(decodeSvgBase64Payload({ svg: svgWith(MIME_TYPES.diagram, scene) }))
        ).toEqual(scene);
        expect(() =>
            decodeSvgBase64Payload({ svg: svgWith("application/x-other", scene) })
        ).toThrow("INVALID");
    });

    it("recognizes the diagram file extensions", async () => {
        expect(getMimeType("saved.diagram")).toBe(MIME_TYPES.json);
        expect(getMimeType("saved.polaris-diagram")).toBe(MIME_TYPES.json);
        expect(getMimeType("notes.txt")).toBe("");
        const lib = await normalizeFile(new File(["{}"], "shapes.diagramlib"));
        expect(lib.type).toBe(MIME_TYPES.diagramlib);
        const scene = await normalizeFile(new File(["{}"], "saved.polaris-diagram"));
        expect(scene.type).toBe(MIME_TYPES.diagram);
    });
});
