// @vitest-environment jsdom

/**
 * Putting several tags on a task without touching the mouse between them.
 *
 * The picker filters as you type, which is the easy half. The half that decides
 * whether anybody uses it is what happens either side of the pick: tab has to
 * reach the list (a menu refuses tab everywhere else, so the key people press
 * after typing half a name used to close the picker), and the pick has to leave
 * the field empty and focused - otherwise the second tag of two is typed into a
 * box that still holds the first one's name and matches nothing.
 */

import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { TagPicker } from "@/app/(app)/tasks/pickers";
import type { TagView } from "@/lib/tasks/space-service";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

const TAGS: TagView[] = [
    { id: "t1", name: "backend", color: "#4477ff" },
    { id: "t2", name: "frontend", color: "#22aa66" }
];

function Harness({ onPicked }: { onPicked?: (ids: string[]) => void }) {
    const [selected, setSelected] = useState<string[]>([]);
    return (
        <TagPicker
            tags={TAGS}
            selected={selected}
            onChange={(ids) => {
                setSelected(ids);
                onPicked?.(ids);
            }}
        />
    );
}

/** Open the picker and wait for the field to hold the keyboard. */
async function open(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Tags" }));
    const field = await screen.findByLabelText("Find a tag");
    await waitFor(() => expect(document.activeElement).toBe(field));
    return field as HTMLInputElement;
}

describe("the tag picker's keyboard", () => {
    it("steps into the list on tab instead of closing", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const field = await open(user);

        await user.keyboard("back{Tab}");
        expect(document.activeElement).not.toBe(field);
        expect(document.activeElement?.textContent).toContain("backend");
    });

    it("puts the tag on the task when enter lands on it", async () => {
        const user = userEvent.setup();
        const picked: string[][] = [];
        render(<Harness onPicked={(ids) => picked.push(ids)} />);
        await open(user);

        await user.keyboard("back{Tab}{Enter}");
        expect(picked).toEqual([["t1"]]);
    });

    it("empties the field and takes the keyboard back, ready for the next tag", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const field = await open(user);

        await user.keyboard("back{Tab}{Enter}");
        await waitFor(() => expect(document.activeElement).toBe(field));
        expect(field.value).toBe("");
    });

    it("takes the second tag typed straight after the first", async () => {
        const user = userEvent.setup();
        const picked: string[][] = [];
        render(<Harness onPicked={(ids) => picked.push(ids)} />);
        await open(user);

        await user.keyboard("back{Tab}{Enter}");
        await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Find a tag")));
        await user.keyboard("front{Tab}{Enter}");

        expect(picked.at(-1)).toEqual(["t1", "t2"]);
    });
});
