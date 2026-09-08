/**
 * Whose rectangle wins.
 *
 * A drawing is the one thing here a CRDT cannot merge inside: two people
 * dragging one shape produce two whole shapes, and something has to choose. The
 * rule is on the shape - a version that counts up, a nonce that breaks a tie -
 * and it has to give the same answer on every screen, because a canvas where two
 * people disagree about where a box is is a canvas nobody trusts again.
 *
 * The failures pinned here are the three that actually happen: a shape jumping
 * back after somebody moves it, a deleted shape coming back, and a canvas
 * sending everything it holds on every pointer move.
 */

import { describe, expect, it } from "vitest";
import { changedElements, laterOf, reconcileScene, type SceneElement } from "@/lib/office/scene";

function shape(id: string, version: number, over: Partial<SceneElement> = {}): SceneElement {
    return { id, version, versionNonce: version * 7, ...over };
}

describe("which version of a shape is the later", () => {
    it("is the one with the higher version", () => {
        expect(laterOf(shape("a", 2), shape("a", 1)).version).toBe(2);
        expect(laterOf(shape("a", 1), shape("a", 2)).version).toBe(2);
    });

    it("breaks a tie the same way on both screens", () => {
        // Two people who each moved a shape exactly once since they last spoke.
        // Any consistent rule works; what matters is that both sides pick the
        // same one, so this is Excalidraw's own - the lower nonce.
        const mine = { id: "a", version: 4, versionNonce: 10 };
        const theirs = { id: "a", version: 4, versionNonce: 3 };
        expect(laterOf(mine, theirs).versionNonce).toBe(3);
        expect(laterOf(theirs, mine).versionNonce).toBe(3);
    });

    it("treats a shape with no version as the oldest there is", () => {
        expect(laterOf(shape("a", 1), { id: "a" }).version).toBe(1);
    });
});

describe("reconciling two canvases", () => {
    it("keeps the newer of each shape", () => {
        const mine = [shape("a", 5), shape("b", 1)];
        const theirs = [shape("a", 2), shape("b", 9)];
        expect(reconcileScene(mine, theirs).map((one) => [one.id, one.version])).toEqual([
            ["a", 5],
            ["b", 9]
        ]);
    });

    it("does not drag a shape back to where it was", () => {
        // The failure this is written for: somebody moves a box, a frame arrives
        // carrying the old position, and the box jumps back under the pointer.
        const moved = shape("a", 12, { x: 400 });
        const stale = shape("a", 3, { x: 10 });
        expect(reconcileScene([moved], [stale])[0]?.x).toBe(400);
    });

    it("keeps a deletion, so a deleted shape does not come back", () => {
        // A deletion IS a version of the shape. Dropping it means this canvas
        // sends the shape again on its next change and everybody sees it return.
        const deleted = shape("a", 8, { isDeleted: true });
        const merged = reconcileScene([shape("a", 2)], [deleted]);
        expect(merged[0]?.isDeleted).toBe(true);
    });

    it("keeps what arrived in the order it arrived, and adds ours after", () => {
        // A shape somebody else drew should keep the place they gave it rather
        // than jumping to the end of the list every time this screen reconciles.
        const merged = reconcileScene([shape("mine", 1)], [shape("x", 1), shape("y", 1)]);
        expect(merged.map((one) => one.id)).toEqual(["x", "y", "mine"]);
    });

    it("has an answer when one side is empty", () => {
        expect(reconcileScene([], [shape("a", 1)]).map((one) => one.id)).toEqual(["a"]);
        expect(reconcileScene([shape("a", 1)], []).map((one) => one.id)).toEqual(["a"]);
        expect(reconcileScene([], [])).toEqual([]);
    });
});

describe("what is worth sending", () => {
    it("is what the other side does not have", () => {
        const held = new Map([["a", shape("a", 3)]]);
        expect(changedElements([shape("a", 3), shape("b", 1)], held).map((one) => one.id)).toEqual([
            "b"
        ]);
    });

    it("is what the other side has an older version of", () => {
        const held = new Map([["a", shape("a", 3)]]);
        expect(changedElements([shape("a", 4)], held).map((one) => one.id)).toEqual(["a"]);
    });

    it("is nothing at all when nothing moved", () => {
        // The canvas fires a change on a hover and on a selection. Writing on
        // those is a write per frame, which is the difference between a wire
        // that keeps up on a busy drawing and one that does not.
        const held = new Map([["a", shape("a", 3)]]);
        expect(changedElements([shape("a", 3)], held)).toEqual([]);
    });

    it("is nothing when the other side is ahead", () => {
        const held = new Map([["a", shape("a", 9)]]);
        expect(changedElements([shape("a", 2)], held)).toEqual([]);
    });
});
