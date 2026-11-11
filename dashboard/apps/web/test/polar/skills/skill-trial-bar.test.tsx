// @vitest-environment jsdom
/**
 * The bar over a skill being tried: it can be added, and it can be stopped,
 * which is how somebody leaves the trial.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SkillTrialBar } from "@/components/polar/polar-skill-trial";

afterEach(cleanup);

describe("a skill being tried", () => {
    it("can be stopped from its bar", () => {
        const onEnd = vi.fn();
        render(
            <SkillTrialBar
                trial={
                    {
                        name: "Summarize a thread",
                        trial: { name: "summarize", body: "Do it." }
                    } as never
                }
                onEnd={onEnd}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText(/Trying Summarize a thread/)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Add skill" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Stop trying" }));
        expect(onEnd).toHaveBeenCalledTimes(1);
    });
});
