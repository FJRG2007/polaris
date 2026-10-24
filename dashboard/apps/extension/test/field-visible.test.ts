// @vitest-environment jsdom
/**
 * The Polaris mark goes only on a box somebody can see.
 *
 * jsdom has no layout, so each case states the layout a browser would report:
 * the box, the window, what CSS says, and what is drawn on top at a point.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fieldVisible } from "@/lib/field-visible";

const BOX = new DOMRect(100, 100, 240, 36);

let field: HTMLInputElement;
let onTop: Element | null;

beforeEach(() => {
    document.body.innerHTML = `<form><label for="u">Email</label><input id="u" /></form>`;
    field = document.getElementById("u") as HTMLInputElement;
    onTop = field;
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    field.checkVisibility = () => true;
    document.elementFromPoint = () => onTop;
});

afterEach(() => vi.restoreAllMocks());

describe("fieldVisible", () => {
    it("marks an ordinary visible field", () => {
        expect(fieldVisible(field, BOX)).toBe(true);
    });

    it("skips a box too small to be a real field", () => {
        expect(fieldVisible(field, new DOMRect(100, 100, 40, 36))).toBe(false);
    });

    it("skips a field CSS hides (opacity 0, visibility hidden)", () => {
        field.checkVisibility = () => false;
        expect(fieldVisible(field, BOX)).toBe(false);
    });

    it("skips a field pushed off the screen", () => {
        expect(fieldVisible(field, new DOMRect(-9999, 100, 240, 36))).toBe(false);
        expect(fieldVisible(field, new DOMRect(100, 900, 240, 36))).toBe(false);
    });

    it("skips a field scrolled out of a clipping panel", () => {
        const form = field.parentElement!;
        form.style.overflowX = "hidden";
        form.style.overflowY = "hidden";
        vi.spyOn(form, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 90));
        expect(fieldVisible(field, BOX)).toBe(false);
    });

    it("skips a field under a modal or a cookie wall", () => {
        const wall = document.createElement("div");
        document.body.appendChild(wall);
        onTop = wall;
        expect(fieldVisible(field, BOX)).toBe(false);
    });

    it("keeps a field whose own label floats over part of it", () => {
        const label = document.querySelector("label")!;
        let call = 0;
        document.elementFromPoint = () => (call++ === 0 ? label : field);
        expect(fieldVisible(field, BOX)).toBe(true);
    });

    it("keeps a field where the thing on top is our own mark", () => {
        const mark = document.createElement("div");
        document.body.appendChild(mark);
        onTop = mark;
        expect(fieldVisible(field, BOX, (node) => node === mark)).toBe(true);
    });
});
