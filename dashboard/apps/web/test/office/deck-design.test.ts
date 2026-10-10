/**
 * A deck's look, its layouts, and several boxes handled at once.
 *
 * Pinned around what goes wrong quietly: a slide that turns dark because the
 * app did, a layout that throws away words somebody typed, a group that comes
 * apart when it is lined up, and a snap that moves a box that was nowhere near
 * anything.
 */

import * as Y from "yjs";
import * as deck from "@/lib/office/deck";
import { describe, expect, it } from "vitest";
import * as edits from "@/app/(app)/office/p/[id]/deck-edits";

const box = (id: string, frame: Partial<deck.Box> = {}): deck.Box => ({
    ...deck.newBox("shape", id),
    x: 0.1,
    y: 0.1,
    w: 0.1,
    h: 0.1,
    ...frame
});

describe("the theme", () => {
    it("is white with dark words for a deck that never chose one", () => {
        const theme = deck.readTheme(new Map());
        expect(theme.background).toBe("#ffffff");
        expect(deck.lookOf(theme, new Map(), "s").background).toBe("#ffffff");
        expect(deck.themeIdOf(theme)).toBe("light");
    });

    it("keeps nothing that is not a colour or an offered face", () => {
        const theme = deck.readTheme(
            new Map<string, unknown>([
                ["background", "url(javascript:alert(1))"],
                ["text", "#000"],
                ["headingFont", "Comic Sans; color: red"]
            ])
        );
        expect(theme.background).toBe(deck.DEFAULT_THEME.background);
        expect(theme.text).toBe("#000");
        expect(theme.headingFont).toBe(deck.DEFAULT_THEME.headingFont);
    });

    it("gives way to a slide's own background", () => {
        const look = deck.lookOf(deck.THEMES.dark, new Map([["s", "#fef08a"]]), "s");
        expect(look.background).toBe("#fef08a");
        expect(look.text).toBe(deck.THEMES.dark.text);
        expect(deck.lookOf(deck.THEMES.dark, new Map([["s", "red"]]), "s").background).toBe(
            deck.THEMES.dark.background
        );
    });

    it("sets a title in the heading face and the rest in the body face", () => {
        const look = deck.lookOf(deck.THEMES.ocean, new Map(), "s");
        expect(deck.fontOf({ role: "title", font: "" }, look)).toBe("Trebuchet MS");
        expect(deck.fontOf({ role: "body", font: "" }, look)).toBe("Verdana");
        expect(deck.fontOf({ role: "title", font: "Georgia" }, look)).toBe("Georgia");
    });
});

describe("a box from before layouts", () => {
    it("is a title when it is the title every slide was given", () => {
        expect(deck.readBox({ id: "title", kind: "text" }).role).toBe("title");
        expect(deck.readBox({ id: "other", kind: "text" }).role).toBe("");
        expect(deck.readBox({ id: "a", kind: "text", font: "Nope" }).font).toBe("");
    });
});

describe("layouts", () => {
    it("start a slide with empty placeholders in their places", () => {
        const boxes = deck.layoutBoxes("twoColumns");
        expect(boxes.map((one) => one.role)).toEqual(["title", "body", "body"]);
        expect(boxes.every((one) => one.text === "")).toBe(true);
        expect(deck.layoutBoxes("blank")).toEqual([]);
    });

    it("move the parts a slide has into place and keep their words", () => {
        const slide = [
            { ...deck.layoutBoxes("title")[0]!, text: "Plan" },
            deck.layoutBoxes("title")[1]!,
            box("pic", { kind: "image" })
        ];
        let next = 0;
        const change = deck.applyLayout(slide, "titleBody", () => `new${(next += 1)}`);
        const title = change.set.find((one) => one.id === "title")!;
        expect(title.text).toBe("Plan");
        expect(title.y).toBeCloseTo(0.06);
        // The empty subtitle has no place here; the picture is not touched.
        expect(change.remove).toEqual(["subtitle"]);
        expect(change.set.some((one) => one.id === "pic")).toBe(false);
        expect(change.set.find((one) => one.role === "body")?.id).toBe("body");
    });

    it("never throw away words the layout has no place for", () => {
        const slide = [{ ...deck.layoutBoxes("title")[1]!, text: "By me" }];
        const change = deck.applyLayout(slide, "section", () => "x");
        expect(change.remove).toEqual([]);
        expect(change.set.find((one) => one.id === "subtitle")).toMatchObject({
            role: "",
            text: "By me"
        });
    });
});

describe("several boxes at once", () => {
    it("move through the stack keeping their order among themselves", () => {
        const on = [box("a", { z: 1 }), box("b", { z: 2 }), box("c", { z: 3 }), box("d", { z: 4 })];
        const order = (changes: Map<string, number>): string[] =>
            deck
                .stackOrder(on.map((one) => ({ ...one, z: changes.get(one.id) ?? one.z })))
                .map((one) => one.id);
        expect(order(deck.arrange(on, ["a", "b"], "front"))).toEqual(["c", "d", "a", "b"]);
        expect(order(deck.arrange(on, ["a", "c"], "forward"))).toEqual(["b", "a", "d", "c"]);
        expect(order(deck.arrange(on, ["c", "d"], "back"))).toEqual(["c", "d", "a", "b"]);
        expect(deck.arrange(on, ["c", "d"], "front").size).toBe(0);
    });

    it("line up with each other, or one with the slide", () => {
        const two = [box("a", { x: 0.1, w: 0.2 }), box("b", { x: 0.5, w: 0.1 })];
        expect(deck.alignBoxes(two, "right").get("a")?.x).toBeCloseTo(0.4);
        expect(deck.alignBoxes(two, "right").has("b")).toBe(false);
        expect(deck.alignBoxes([two[0]!], "center").get("a")?.x).toBeCloseTo(0.4);
    });

    it("line up a group as one thing", () => {
        const grouped = [
            box("a", { x: 0.1, w: 0.1, group: "g" }),
            box("b", { x: 0.3, w: 0.1, group: "g" }),
            box("c", { x: 0.7, w: 0.1 })
        ];
        const moved = deck.alignBoxes(grouped, "right");
        expect(moved.get("a")?.x).toBeCloseTo(0.5);
        expect(moved.get("b")?.x).toBeCloseTo(0.7);
    });

    it("space out evenly between the first and the last", () => {
        const three = [
            box("a", { x: 0, w: 0.1 }),
            box("b", { x: 0.15, w: 0.2 }),
            box("c", { x: 0.9, w: 0.1 })
        ];
        const moved = deck.distributeBoxes(three, "x");
        // Span 1, filled 0.4, two gaps of 0.3.
        expect(moved.get("b")?.x).toBeCloseTo(0.4);
        expect(moved.has("a")).toBe(false);
        expect(deck.distributeBoxes(three.slice(0, 2), "x").size).toBe(0);
    });

    it("scale into a resized frame round them", () => {
        const scaled = deck.scaleInto(
            { x: 0.2, y: 0.2, w: 0.1, h: 0.1 },
            { x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
            { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }
        );
        expect(scaled).toEqual({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 });
    });

    it("are picked up by a rectangle round them, a group only whole", () => {
        const on = [
            box("a", { x: 0.1, y: 0.1 }),
            box("b", { x: 0.5, y: 0.1, group: "g" }),
            box("c", { x: 0.8, y: 0.1, group: "g" })
        ];
        expect(deck.inArea(on, { x: 0, y: 0, w: 0.7, h: 0.5 })).toEqual(["a"]);
        expect(deck.inArea(on, { x: 0, y: 0, w: 1, h: 0.5 })).toEqual(["a", "b", "c"]);
        expect(deck.unitOf(on, "b")).toEqual(["b", "c"]);
        expect(deck.canGroup([on[1]!, on[2]!])).toBe(false);
        expect(deck.canGroup([on[0]!, on[1]!])).toBe(true);
    });
});

describe("snapping", () => {
    const tolerance = { x: 0.01, y: 0.01 };

    it("pulls a box's middle onto the slide's", () => {
        const snapped = deck.snapMove(
            { x: 0.445, y: 0.3, w: 0.1, h: 0.1 },
            deck.snapTargets([]),
            tolerance
        );
        expect(snapped.frame.x).toBeCloseTo(0.45);
        expect(snapped.guides).toContainEqual({ axis: "x", at: 0.5 });
    });

    it("pulls an edge onto another box's, and leaves a box alone that is far from all", () => {
        const targets = deck.snapTargets([{ x: 0.6, y: 0.6, w: 0.2, h: 0.2 }]);
        expect(
            deck.snapMove({ x: 0.205, y: 0.205, w: 0.1, h: 0.1 }, targets, tolerance).frame
        ).toEqual({ x: 0.205, y: 0.205, w: 0.1, h: 0.1 });
        const resized = deck.snapResize(
            { x: 0.3, y: 0.3, w: 0.295, h: 0.1 },
            "e",
            targets,
            tolerance
        );
        expect(resized.frame.x + resized.frame.w).toBeCloseTo(0.6);
        expect(resized.frame.x).toBeCloseTo(0.3);
    });
});

describe("the clipboard", () => {
    it("pastes a group as a new group of the copies", () => {
        const raw = deck.writeClipboard([
            box("a", { group: "g" }),
            box("b", { group: "g" }),
            box("c")
        ]);
        let next = 0;
        const pasted = deck.readClipboard(raw, () => `id${(next += 1)}`);
        expect(pasted[0]!.group).not.toBe("g");
        expect(pasted[0]!.group).toBe(pasted[1]!.group);
        expect(pasted[2]!.group).toBe("");
    });
});

describe("the deck's design, as written", () => {
    it("sets a theme and takes it back in one step", () => {
        const doc = new Y.Doc();
        const history = edits.deckUndoManager(doc);
        edits.setTheme(doc, deck.THEMES.ocean);
        expect(deck.readTheme(new Map(edits.themeOf(doc).entries())).background).toBe("#0b3954");
        history.undo();
        expect(deck.readTheme(new Map(edits.themeOf(doc).entries())).background).toBe("#ffffff");
    });

    it("fills a new shape with the theme's accent", () => {
        const doc = new Y.Doc();
        edits.setTheme(doc, deck.THEMES.forest);
        const slide = edits.addSlide(doc, 0, "blank");
        const id = edits.addBox(doc, slide, "shape", "ellipse");
        expect(edits.boxesOf(doc).get(deck.boxKey(slide, id))?.fill).toBe(
            deck.THEMES.forest.accent
        );
    });

    it("keeps a slide's background with it, and lets it go with it", () => {
        const doc = new Y.Doc();
        const slide = edits.addSlide(doc, 0, "title");
        edits.setBackground(doc, [slide], "#fef08a");
        edits.setBackground(doc, [slide], "not a colour");
        expect(edits.backgroundsOf(doc).get(slide)).toBe("#fef08a");
        const copy = edits.duplicateSlide(doc, slide, 0);
        expect(edits.backgroundsOf(doc).get(copy)).toBe("#fef08a");
        edits.removeSlide(doc, slide);
        expect(edits.backgroundsOf(doc).has(slide)).toBe(false);
        edits.backgroundEverywhere(doc, "#fef08a");
        expect(edits.backgroundsOf(doc).size).toBe(0);
        expect(edits.themeOf(doc).get("background")).toBe("#fef08a");
    });

    it("groups, ungroups and lays out a slide, each one step back", () => {
        const doc = new Y.Doc();
        const history = edits.deckUndoManager(doc);
        const slide = edits.addSlide(doc, 0, "title");
        edits.groupBoxes(doc, slide, ["title", "subtitle"]);
        const read = (id: string): deck.Box =>
            deck.readBox(edits.boxesOf(doc).get(deck.boxKey(slide, id)));
        expect(read("title").group).not.toBe("");
        expect(read("title").group).toBe(read("subtitle").group);
        history.undo();
        expect(read("title").group).toBe("");
        edits.applyLayout(doc, slide, "titleBody");
        expect(edits.boxesOf(doc).has(deck.boxKey(slide, "subtitle"))).toBe(false);
        expect(edits.boxesOf(doc).has(deck.boxKey(slide, "body"))).toBe(true);
        history.undo();
        expect(edits.boxesOf(doc).has(deck.boxKey(slide, "subtitle"))).toBe(true);
    });
});
