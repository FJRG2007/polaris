// @vitest-environment jsdom

/**
 * Which occurrences of a repeating event a change reaches is asked in a real
 * dialog, answered as a promise; closing it answers nothing, so the caller does
 * nothing.
 */

import "@/components/app-host/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EditScope } from "@polaris-app/calendar/src/engine";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useScopeChoice, type ScopeQuestion } from "@polaris-app/calendar/src/screens/scope-dialog";

let ask: ((question: ScopeQuestion) => Promise<EditScope | null>) | null = null;

function Harness() {
    const [asker, element] = useScopeChoice();
    ask = asker;
    return <>{element}</>;
}

afterEach(() => {
    cleanup();
    ask = null;
});

/** The answer is handed back in a box: an async function that returned the
 *  promise itself would wait for the dialog to be answered before returning. */
async function question(input: ScopeQuestion): Promise<{ answer: Promise<EditScope | null> }> {
    let answer: Promise<EditScope | null> = Promise.resolve(null);
    await act(async () => {
        answer = ask!(input);
    });
    return { answer };
}

describe("the scope dialog", () => {
    it("offers this, this and following, and all, and answers with the one pressed", async () => {
        render(<Harness />);
        const { answer } = await question({ action: "delete" });
        expect(screen.getByRole("dialog", { name: "Delete a repeating event" })).toBeDefined();
        expect(screen.getByRole("button", { name: "This event" })).toBeDefined();
        expect(screen.getByRole("button", { name: "All events" })).toBeDefined();
        fireEvent.click(screen.getByRole("button", { name: "This and following events" }));
        await expect(answer).resolves.toBe("following");
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("leaves out 'this event' when the rule itself changed", async () => {
        render(<Harness />);
        await question({ action: "save", allowThis: false });
        expect(screen.getByRole("dialog", { name: "Change a repeating event" })).toBeDefined();
        expect(screen.queryByRole("button", { name: "This event" })).toBeNull();
        expect(screen.getByRole("button", { name: "This and following events" })).toBeDefined();
    });

    it("answers null when it is cancelled", async () => {
        render(<Harness />);
        const { answer } = await question({ action: "move" });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await expect(answer).resolves.toBeNull();
    });
});
