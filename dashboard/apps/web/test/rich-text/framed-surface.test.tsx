// @vitest-environment jsdom

/**
 * A composer draws its own field, so the writing surface inside it takes no
 * hover tint: a tint over part of the box read as a second control. Surfaces
 * that are not framed - a task's description - keep the tint that says they
 * can be edited.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/app/(app)/mention-actions", () => ({
    resolveReferencesAction: async () => ({}),
    searchMentionsAction: async () => []
}));

const { RichTextEditor } = await import("@/components/rich-text/rich-text-editor");

afterEach(cleanup);

const HOVER_TINT = "[&:not(:focus-within):hover]:bg-muted/40";

function surface(framed: boolean): string {
    const { container } = render(
        <RichTextEditor value="" onChange={() => undefined} framed={framed} />,
        { wrapper: MessagesWrapper }
    );
    return (container.firstElementChild as HTMLElement).className;
}

describe("the writing surface inside a composer", () => {
    it("has no hover tint when the caller frames it", () => {
        expect(surface(true)).not.toContain(HOVER_TINT);
    });

    it("keeps the tint where the surface stands on its own", () => {
        expect(surface(false)).toContain(HOVER_TINT);
    });
});
