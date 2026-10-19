/**
 * Editing a sent message, or answering again, keeps the earlier version: the
 * conversation is a tree, and "< 1 of 2 >" walks between siblings.
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { learnPath, pathThrough, versionsOf, type VersionTree } from "@/lib/polar/versions";

function message(id: string, role: "user" | "assistant"): UIMessage {
    return { id, role, parts: [{ type: "text", text: id }] };
}

const ids = (messages: readonly UIMessage[]) => messages.map((entry) => entry.id);

describe("the version tree", () => {
    it("keeps an edited message beside the one it replaced, and shows the newest path", () => {
        const tree: VersionTree = new Map();
        learnPath(tree, [message("u1", "user"), message("a1", "assistant")]);
        // The person edits u1: the screen drops it and sends u1b in its place.
        learnPath(tree, [message("u1b", "user"), message("a1b", "assistant")]);
        expect(versionsOf(tree, "u1b")).toEqual(["u1", "u1b"]);
        expect(versionsOf(tree, "a1b")).toEqual(["a1b"]);
        // Back to the first version brings its own answer with it.
        expect(ids(pathThrough(tree, [], 0, "u1"))).toEqual(["u1", "a1"]);
        expect(ids(pathThrough(tree, [], 0, "u1b"))).toEqual(["u1b", "a1b"]);
    });

    it("treats an answer given again as a sibling of the first answer", () => {
        const tree: VersionTree = new Map();
        const question = message("u1", "user");
        learnPath(tree, [question, message("a1", "assistant")]);
        learnPath(tree, [question, message("a2", "assistant")]);
        expect(versionsOf(tree, "a2")).toEqual(["a1", "a2"]);
        expect(ids(pathThrough(tree, [question], 1, "a1"))).toEqual(["u1", "a1"]);
    });

    it("places stored messages by the parent they were saved with", () => {
        const tree: VersionTree = new Map();
        const stored = [message("u1", "user"), message("a1", "assistant"), message("u1b", "user")];
        learnPath(
            tree,
            stored,
            new Map([
                ["u1", null],
                ["a1", "u1"],
                ["u1b", null]
            ])
        );
        expect(versionsOf(tree, "u1")).toEqual(["u1", "u1b"]);
        expect(ids(pathThrough(tree, [], 0, "u1"))).toEqual(["u1", "a1"]);
    });

    it("refreshes a message's content in place without moving it", () => {
        const tree: VersionTree = new Map();
        learnPath(tree, [message("u1", "user")]);
        const updated = {
            ...message("u1", "user"),
            parts: [{ type: "text" as const, text: "changed" }]
        };
        learnPath(tree, [message("x", "assistant"), updated]);
        expect(tree.get("u1")?.parentId).toBeNull();
        expect(tree.get("u1")?.message.parts).toEqual(updated.parts);
    });
});
