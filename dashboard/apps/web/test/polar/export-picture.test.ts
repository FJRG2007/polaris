// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { pictureOf } from "@/lib/polar/export-picture";

const PAGE = (words: string) =>
    `<!doctype html><html><head><style>p{margin:0}</style></head><body><p>${words}</p></body></html>`;

beforeAll(() => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});

function read(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
    });
}

describe("the SVG export", () => {
    it("is well formed when the chat holds characters XML forbids", async () => {
        const blob = await pictureOf(PAGE("colour \u001b[31mred\u001b[0m and \ud83d alone"), "svg");
        const svg = await read(blob);
        expect(svg).not.toContain("\u001b");
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        expect(parsed.querySelector("parsererror")).toBeNull();
        expect(parsed.documentElement.textContent).toContain("[31mred[0m");
        expect(() => encodeURIComponent(svg)).not.toThrow();
    });
});
