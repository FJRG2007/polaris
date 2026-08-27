// @vitest-environment jsdom

/**
 * A tag created in a picker, once the server has answered.
 *
 * The bug this pins is the one that kept coming back: type a name no tag carries,
 * press enter, and the tag is created and NOT put on the task - press enter a
 * second time and it lands, because by then the tag really exists.
 *
 * The cause was a draft asking the wrong question. It held a chip under the id
 * this browser invented, and to decide whether that chip was still good it looked
 * for the id in the list of tags it would draw. That list deliberately drops a
 * created tag the moment the server sends the real one back under the same name -
 * two entries for one tag in a picker is worse - so a successful creation looked
 * exactly like a refused one, and the chip came off a task somebody had just
 * tagged.
 *
 * So: an entry stays good until it is refused, and only a refusal takes it out.
 */

import { createElement } from "react";
import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createTagAction = vi.fn();
const show = vi.fn();

vi.mock("../../src/app/(app)/tasks/actions", () => ({ createTagAction }));
vi.mock("@polaris/ui", () => ({ useToast: () => ({ show }) }));
vi.mock("@/lib/run-action", () => ({
    runAction: async (work: () => Promise<unknown>) => work()
}));

const { isProvisionalTagId, settleTagIds, tagCreationLives, useTagCreation } = await import(
    "../../src/app/(app)/tasks/tag-creation"
);

/** The hook, from a component that does nothing else. `tags` is what the server
 *  has sent for the space, which is what changes under a draft's feet. */
function book(spaceId: string, tags: { id: string; name: string; color: string }[] = []) {
    const held: { create: ((name: string, color: string) => Promise<string>) | null; tags: readonly { id: string }[] } =
        { create: null, tags: [] };
    function Probe() {
        const value = useTagCreation(spaceId, tags);
        held.create = value.create;
        held.tags = value.tags;
        return null;
    }
    render(createElement(Probe));
    return held;
}

afterEach(cleanup);

beforeEach(() => {
    vi.clearAllMocks();
});

describe("a tag created from a picker", () => {
    it("stays on the task after the server sends the real one back", async () => {
        createTagAction.mockResolvedValue({ tag: { id: "real-1", name: "backend", color: "#888" } });
        const held = book("space-1");

        const id = await held.create!("backend", "#888888");
        expect(isProvisionalTagId(id)).toBe(true);

        // What the write does, which is also what waits for the answer.
        expect(await settleTagIds([id])).toEqual(["real-1"]);

        // The server's list now names it, which is the moment the old rule broke:
        // the list a draft was checking against no longer holds the invented id.
        const after = book("space-1", [{ id: "real-1", name: "backend", color: "#888" }]);
        expect(after.tags.some((tag) => tag.id === id)).toBe(false);

        // And the chip is still good, which is the whole fix.
        expect(tagCreationLives(id)).toBe(true);
    });

    it("comes off only when the server refused it", async () => {
        createTagAction.mockResolvedValue({ error: "A tag with that name already exists" });
        const held = book("space-1");

        const id = await held.create!("backend", "#888888");
        expect(await settleTagIds([id])).toEqual([]);
        expect(tagCreationLives(id)).toBe(false);
        expect(show).toHaveBeenCalled();
    });

    it("says nothing about an id it never made", () => {
        expect(tagCreationLives("real-1")).toBe(false);
    });
});
