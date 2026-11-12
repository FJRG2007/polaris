// @vitest-environment jsdom
/**
 * The model picker's search: a typo still finds the model, nonsense says
 * nothing matches, Enter takes the top result, and Escape empties the field
 * before it closes the menu.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
    firstModels,
    ModelSelector,
    MODELS_PAGE,
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";

const PROVIDERS: ModelSelectorProvider[] = [
    {
        provider: "anthropic",
        name: "Anthropic",
        payers: ["own"],
        models: [
            {
                provider: "anthropic",
                model: "claude-sonnet",
                name: "Claude Sonnet",
                reasoning: true
            },
            { provider: "anthropic", model: "claude-haiku", name: "Claude Haiku", reasoning: true }
        ]
    },
    {
        provider: "openai",
        name: "OpenAI",
        payers: ["own"],
        models: [{ provider: "openai", model: "gpt-5", name: "GPT-5", reasoning: true }]
    }
];

afterEach(cleanup);

function open(onChoice = vi.fn()) {
    render(<ModelSelector providers={PROVIDERS} choice={null} onChoice={onChoice} />, {
        wrapper: MessagesWrapper
    });
    fireEvent.pointerDown(screen.getByTitle("Model, intelligence and key"), {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse"
    });
    return onChoice;
}

describe("the model search", () => {
    it("finds a model by a misspelled name and keeps its provider heading", async () => {
        open();
        fireEvent.change(await screen.findByLabelText("Find a model"), {
            target: { value: "sonet" }
        });
        expect(screen.getByText("Claude Sonnet")).toBeTruthy();
        expect(screen.getByText("Anthropic")).toBeTruthy();
        expect(screen.queryByText("GPT-5")).toBeNull();
        expect(screen.queryByText("OpenAI")).toBeNull();
    });

    it("says when nothing matches", async () => {
        open();
        fireEvent.change(await screen.findByLabelText("Find a model"), {
            target: { value: "zzqqxx" }
        });
        expect(screen.getByText("No models match")).toBeTruthy();
        expect(screen.queryByText("Claude Sonnet")).toBeNull();
    });

    it("takes the top result on Enter", async () => {
        const onChoice = open();
        const field = await screen.findByLabelText("Find a model");
        fireEvent.change(field, { target: { value: "gpt5" } });
        fireEvent.keyDown(field, { key: "Enter" });
        await waitFor(() =>
            expect(onChoice).toHaveBeenCalledWith(
                expect.objectContaining({ provider: "openai", model: "gpt-5" })
            )
        );
    });

    it("empties the search on Escape before closing", async () => {
        open();
        const field = (await screen.findByLabelText("Find a model")) as HTMLInputElement;
        fireEvent.change(field, { target: { value: "haiku" } });
        fireEvent.keyDown(field, { key: "Escape" });
        expect(field.value).toBe("");
        expect(screen.getByText("GPT-5")).toBeTruthy();
        fireEvent.keyDown(field, { key: "Escape" });
        await waitFor(() => expect(screen.queryByLabelText("Find a model")).toBeNull());
    });
});

describe("a long catalogue", () => {
    const many: ModelSelectorProvider[] = [
        {
            provider: "openrouter",
            name: "OpenRouter",
            payers: ["own"],
            models: Array.from({ length: MODELS_PAGE + 15 }, (_, index) => ({
                provider: "openrouter",
                model: `m-${index}`,
                name: `Model ${index}`,
                reasoning: false
            }))
        }
    ];

    it("draws a page of models, the rest as the list is scrolled to its end", async () => {
        render(<ModelSelector providers={many} choice={null} onChoice={vi.fn()} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.pointerDown(screen.getByTitle("Model, intelligence and key"), {
            button: 0,
            ctrlKey: false,
            pointerType: "mouse"
        });
        await screen.findByText("Model 0");
        expect(screen.queryByText(`Model ${MODELS_PAGE}`)).toBeNull();
        fireEvent.click(screen.getByRole("menuitem", { name: "Show more" }));
        expect(await screen.findByText(`Model ${MODELS_PAGE + 14}`)).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: "Show more" })).toBeNull();
    });

    it("cuts the providers to the first models in their order", () => {
        const { shown, more } = firstModels(PROVIDERS, 2);
        expect(shown.map((entry) => [entry.provider, entry.models.length])).toEqual([
            ["anthropic", 2]
        ]);
        expect(more).toBe(true);
        expect(firstModels(PROVIDERS, 3).more).toBe(false);
    });
});
