// @vitest-environment jsdom

/**
 * Files written before the editor was vendored carry the upstream format
 * identifiers. They still open; new files are written with Polaris's own.
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

describe("legacy diagram files", () => {
    it("accepts a scene saved under the upstream type", () => {
        expect(isValidDiagramData({ type: "excalidraw", elements: [] })).toBe(true);
        expect(isValidDiagramData({ type: EXPORT_DATA_TYPES.diagram, elements: [] })).toBe(true);
        expect(isValidDiagramData({ type: "something-else", elements: [] })).toBe(false);
        expect(isValidDiagramData(undefined)).toBe(false);
    });

    it("accepts a library saved under the upstream type", () => {
        expect(isValidLibrary({ type: "excalidrawlib", version: 2, libraryItems: [] })).toBe(true);
        expect(isValidLibrary({ type: "other", version: 2, libraryItems: [] })).toBe(false);
        expect(JSON.parse(serializeLibraryAsJSON([])).type).toBe(EXPORT_DATA_TYPES.diagramLibrary);
    });

    it("reads the scene from an SVG exported under the upstream MIME type", () => {
        const scene = { type: "excalidraw", elements: [] };
        expect(
            JSON.parse(
                decodeSvgBase64Payload({ svg: svgWith("application/vnd.excalidraw+json", scene) })
            )
        ).toEqual(scene);
        expect(
            JSON.parse(decodeSvgBase64Payload({ svg: svgWith(MIME_TYPES.diagram, scene) }))
        ).toEqual(scene);
        expect(() =>
            decodeSvgBase64Payload({ svg: svgWith("application/x-other", scene) })
        ).toThrow("INVALID");
    });

    it("recognizes the upstream file extensions", async () => {
        expect(getMimeType("old.excalidraw")).toBe(MIME_TYPES.json);
        expect(getMimeType("saved.diagram")).toBe(MIME_TYPES.json);
        const lib = await normalizeFile(new File(["{}"], "shapes.excalidrawlib"));
        expect(lib.type).toBe(MIME_TYPES.diagramlib);
        const scene = await normalizeFile(new File(["{}"], "old.excalidraw"));
        expect(scene.type).toBe(MIME_TYPES.diagram);
    });
});
