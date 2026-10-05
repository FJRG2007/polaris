// @vitest-environment jsdom

/**
 * One rule above the comment box.
 *
 * The report: in a task's activity column, the box for a new comment sat under
 * two separator lines. The chat box draws a rule along its own top edge, and the
 * task thread wrapped it in a bordered block that drew a second one right on top
 * of it. The box keeps its rule; the column no longer adds one.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ActivityStream } from "@/app/(app)/tasks/task-conversation";

vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));
vi.mock("@/app/(app)/chat/actions", () => ({ typingAction: async () => undefined }));
vi.mock("@/app/(app)/tasks/actions", () => ({}));

afterEach(cleanup);

if (!document.elementFromPoint) document.elementFromPoint = () => null;

/** Every element on the way from the comment editor up to the column's root
 *  that draws a rule along its top edge. */
function rulesAboveTheBox(editor: Element, root: Element): Element[] {
    const found: Element[] = [];
    for (let at = editor.parentElement; at && at !== root; at = at.parentElement) {
        if (at.classList.contains("border-t")) found.push(at);
    }
    return found;
}

describe("the task comment box", () => {
    it("sits under exactly one separator", async () => {
        const { container } = render(
            <ActivityStream
                taskId="t1"
                comments={[]}
                activity={[]}
                currentUserId="u1"
                canModerate={false}
                onChanged={() => undefined}
                onError={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        const editor = await waitFor(() => {
            const found = container.querySelector(".ProseMirror");
            if (!found) throw new Error("the editor did not mount");
            return found;
        });
        expect(rulesAboveTheBox(editor, container)).toHaveLength(1);
    });
});
