// @vitest-environment jsdom

/**
 * The words on the button and in the confirm, by what closing the meeting is
 * right now. A scheduled meeting nobody joined used to read "End meeting".
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessagesWrapper } from "../setup/i18n";
import { useRemovalWords } from "@/app/(app)/chat/meetings/meeting-removal";

function words() {
    return renderHook(() => useRemovalWords(), { wrapper: MessagesWrapper }).result.current;
}

describe("closing a meeting is named by its state", () => {
    it("cancels one in the diary", () => {
        const said = words()("cancel", "Planning");
        expect(said.action).toBe("Cancel meeting");
        expect(said.title).toBe("Cancel Planning?");
    });

    it("deletes a room nobody is in", () => {
        const said = words()("delete", "Planning");
        expect(said.action).toBe("Delete meeting");
        expect(said.title).toBe("Delete Planning?");
    });

    it("ends only the one people are in", () => {
        const said = words()("end", "Planning");
        expect(said.action).toBe("End meeting");
        expect(said.title).toBe("End Planning for everybody?");
    });
});
