// @vitest-environment jsdom

/**
 * Typing a tag that does not exist yet and pressing enter, once.
 *
 * The whole point of the field is that a name typed in it is a way of picking
 * one: type "backend", press enter, and the task carries that tag. Pressing
 * enter and being handed a tag that exists and is not on the task is the worst
 * shape this can fail in, because the tag IS created - so the second press works
 * and nothing looks broken afterwards, which is why it survived being reported.
 */

import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagPicker } from "../../src/app/(app)/tasks/pickers";
import type { TagView } from "../../src/lib/tasks/space-service";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

/**
 * The picker as its callers wire it: creating a tag adds it to the space's list
 * straight away (the browser invents an id and the request runs behind it), and
 * what is on the task is state the caller keeps.
 */
function Harness({ onChange }: { onChange: (ids: string[]) => void }) {
    const [tags, setTags] = useState<TagView[]>([]);
    const [selected, setSelected] = useState<string[]>([]);

    return (
        <TagPicker
            tags={tags}
            selected={selected}
            onChange={(ids) => {
                setSelected(ids);
                onChange(ids);
            }}
            onCreate={async (name) => {
                const id = `new-tag:${name}`;
                setTags((current) => [...current, { id, name, color: "#888888" }]);
                return id;
            }}
        />
    );
}

describe("naming a tag that does not exist yet", () => {
    it("puts it on the task on the first press, not the second", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);

        await user.click(screen.getByRole("button", { name: "Tags" }));
        const field = await screen.findByLabelText("Find or create a tag");
        await waitFor(() => expect(document.activeElement).toBe(field));

        await user.type(field, "backend");
        await user.keyboard("{Enter}");

        await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
        expect(onChange).toHaveBeenCalledWith(["new-tag:backend"]);
    });

    it("empties the field, so the next name is typed rather than typed onto", async () => {
        const user = userEvent.setup();
        render(<Harness onChange={() => undefined} />);

        await user.click(screen.getByRole("button", { name: "Tags" }));
        const field = await screen.findByLabelText("Find or create a tag");
        await user.type(field, "backend");
        await user.keyboard("{Enter}");

        await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
    });
});
