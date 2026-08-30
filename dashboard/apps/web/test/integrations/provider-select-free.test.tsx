// @vitest-environment jsdom

/**
 * Finding a provider you can start on today, among sixty.
 *
 * The list stopped being something to read the moment it grew past a screenful,
 * so the two things somebody actually asks it have to be answerable from the
 * field: "the one I already have an account with" (its name, its slug, or the
 * model family it is known by) and "one that costs nothing to try". The second
 * is why the badge is on the row and why the word that is on the badge is a word
 * the search matches.
 */

import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { modelProviderRows } from "@/lib/agents/model-key-providers";
import { ProviderSelect } from "@/components/model-keys/provider-select";

afterEach(cleanup);

function Harness() {
    const [value, setValue] = useState("");
    return <ProviderSelect options={modelProviderRows()} value={value} onChange={setValue} />;
}

/** Open the list and return the field that narrows it. */
async function open(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /pick a provider/i }));
    return screen.getByPlaceholderText("Search providers");
}

describe("the provider list", () => {
    it("badges the providers a key can be had from for nothing", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await open(user);

        // Groq's is an allowance that comes back; Cohere's runs out. Both are
        // free to start on, and the badge says which kind it is.
        expect(screen.getByRole("option", { name: /Groq/ }).textContent).toContain("Free tier");
        expect(screen.getByRole("option", { name: /Cohere/ }).textContent).toContain("Free trial");
    });

    it("says nothing about a provider that bills from the first token", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await open(user);

        const anthropic = screen.getByRole("option", { name: /Anthropic/ });
        expect(anthropic.textContent).not.toContain("Free");
    });

    it("narrows to them when that is what is typed", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const field = await open(user);

        await user.type(field, "free tier");
        const shown = screen.getAllByRole("option");
        expect(shown.length).toBeGreaterThan(1);
        for (const option of shown) expect(option.textContent).toContain("Free tier");
    });

    it("still finds a provider by the family it serves rather than its name", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const field = await open(user);

        await user.type(field, "qwen");
        const names = screen.getAllByRole("option").map((option) => option.textContent ?? "");
        expect(names.some((name) => name.includes("Alibaba"))).toBe(true);
    });

    it("draws a provider with no mark of its own as its own letters, never the generic block", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const field = await open(user);

        await user.type(field, "hugging");
        expect(screen.getByRole("option", { name: /Hugging Face/ }).textContent).toContain("HF");
    });
});
