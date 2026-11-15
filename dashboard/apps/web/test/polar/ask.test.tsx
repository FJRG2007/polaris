// @vitest-environment jsdom

/**
 * Polar's own question (`polar_ask`): the open call is the question waiting,
 * a later message settles it as unanswered before the model reads it, the turn
 * goes on only once the question's step is complete, and the card answers by
 * number, multi-select, free text and Skip.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { MessagesWrapper } = await import("../setup/i18n");
const ask = await import("@/lib/polar/ask");
const { AskChip, PolarAskBar } = await import("@/components/polar/polar-ask");
const { polarAskTools } = await import("@/lib/polar/ask-tools");

afterEach(cleanup);

const questions = [
    {
        question: "Which colour?",
        header: "Colour",
        options: [{ label: "Red" }, { label: "Blue", description: "Calmer" }]
    }
];
const several = [
    ...questions,
    { question: "Which sizes?", multiSelect: true, options: [{ label: "S" }, { label: "M" }, { label: "L" }] }
];

const askPart = (state: string, extra: object = {}) => ({
    type: `tool-${ask.POLAR_ASK_TOOL}`,
    toolCallId: "call-1",
    state,
    input: { questions },
    ...extra
});

describe("ask state", () => {
    it("finds the question only on the newest assistant message", () => {
        const waiting = [{ role: "user", parts: [] }, { role: "assistant", parts: [{ type: "step-start" }, askPart("input-available")] }];
        expect(ask.pendingAsk(waiting)).toEqual({ toolCallId: "call-1", questions });
        expect(ask.pendingAsk([...waiting, { role: "user", parts: [] }])).toBeNull();
        expect(ask.pendingAsk([{ role: "assistant", parts: [askPart("output-available", { output: { status: "skipped" } })] }])).toBeNull();
        expect(ask.pendingAsk([{ role: "assistant", parts: [askPart("input-available", { input: { questions: [] } })] }])).toBeNull();
    });

    it("settles a question the person moved past, and leaves the newest one open", () => {
        const messages = [
            { role: "assistant", parts: [askPart("input-available")] },
            { role: "user", parts: [{ type: "text", text: "never mind" }] },
            { role: "assistant", parts: [askPart("input-available", { toolCallId: "call-2" })] }
        ];
        const settled = ask.settleUnansweredAsks(messages);
        expect(settled[0]!.parts[0]).toMatchObject({ state: "output-available", output: { status: "unanswered" } });
        expect(settled[2]).toBe(messages[2]);
        expect(settled[1]).toBe(messages[1]);
    });

    it("goes on only when the question's step is answered and nothing else waits", () => {
        const answered = askPart("output-available", { output: { status: "answered", answers: { "Which colour?": "Red" } } });
        expect(ask.askAnswered([{ role: "assistant", parts: [{ type: "step-start" }, answered] }])).toBe(true);
        expect(ask.askAnswered([{ role: "assistant", parts: [{ type: "step-start" }, askPart("input-available")] }])).toBe(false);
        // A step that ran out on a finished ordinary tool is not resent.
        expect(
            ask.askAnswered([{ role: "assistant", parts: [{ type: "step-start" }, { type: "tool-polar_weather", state: "output-available" }] }])
        ).toBe(false);
        // The turn already went on: a later step has started.
        expect(ask.askAnswered([{ role: "assistant", parts: [{ type: "step-start" }, answered, { type: "step-start" }, { type: "text", text: "Red it is" }] }])).toBe(false);
        expect(
            ask.askAnswered([
                { role: "assistant", parts: [{ type: "step-start" }, answered, { type: "tool-polar_remember", state: "approval-requested" }] }
            ])
        ).toBe(false);
    });

    it("checks the call and its output", () => {
        expect(ask.askQuestionsOf({ questions: Array.from({ length: 5 }, () => questions[0]) })).toBeNull();
        expect(ask.askOutputOf({ status: "answered", answers: { q: "a" } })).toEqual({ status: "answered", answers: { q: "a" } });
        expect(ask.askOutputOf({ status: "maybe" })).toBeNull();
    });

    it("has no execute, so the turn stops on the call", () => {
        const tools = polarAskTools();
        expect(tools[ask.POLAR_ASK_TOOL]).toBeDefined();
        expect((tools[ask.POLAR_ASK_TOOL] as { execute?: unknown }).execute).toBeUndefined();
    });
});

describe("ask card", () => {
    it("answers a single choice with its number key", () => {
        const onAnswer = vi.fn();
        render(
            <MessagesWrapper>
                <PolarAskBar questions={questions} busy={false} onAnswer={onAnswer} />
            </MessagesWrapper>
        );
        fireEvent.keyDown(window, { key: "2" });
        expect(onAnswer).toHaveBeenCalledWith({ status: "answered", answers: { "Which colour?": "Blue" } });
    });

    it("pages through several questions and counts a multi-select", () => {
        const onAnswer = vi.fn();
        render(
            <MessagesWrapper>
                <PolarAskBar questions={several} busy={false} onAnswer={onAnswer} />
            </MessagesWrapper>
        );
        expect(screen.getByText("1 of 2")).toBeTruthy();
        fireEvent.click(screen.getByRole("radio", { name: /Red/ }));
        expect(screen.getByText("2 of 2")).toBeTruthy();
        fireEvent.click(screen.getByRole("checkbox", { name: /S/ }));
        fireEvent.click(screen.getByRole("checkbox", { name: /L/ }));
        expect(screen.getByText("2 selected")).toBeTruthy();
        fireEvent.click(screen.getByText("Something else"));
        fireEvent.change(screen.getByPlaceholderText("Type your answer"), { target: { value: "XL" } });
        fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
        expect(onAnswer).toHaveBeenCalledWith({
            status: "answered",
            answers: { "Which colour?": "Red", "Which sizes?": "S, L, XL" }
        });
    });

    it("skips", () => {
        const onAnswer = vi.fn();
        render(
            <MessagesWrapper>
                <PolarAskBar questions={questions} busy={false} onAnswer={onAnswer} />
            </MessagesWrapper>
        );
        fireEvent.click(screen.getByRole("button", { name: "Skip" }));
        expect(onAnswer).toHaveBeenCalledWith({ status: "skipped" });
    });

    it("folds into a chip that opens to the answer", () => {
        render(
            <MessagesWrapper>
                <AskChip input={{ questions }} output={{ status: "answered", answers: { "Which colour?": "Red" } }} waiting={false} />
            </MessagesWrapper>
        );
        fireEvent.click(screen.getByRole("button", { name: /Asked a question/ }));
        expect(screen.getByText("Which colour?")).toBeTruthy();
        expect(screen.getByText("Red")).toBeTruthy();
    });

    it("says a question moved past was not answered", () => {
        render(
            <MessagesWrapper>
                <AskChip input={{ questions }} output={undefined} waiting={false} />
            </MessagesWrapper>
        );
        fireEvent.click(screen.getByRole("button", { name: /Asked a question/ }));
        expect(screen.getByText("Not answered")).toBeTruthy();
    });
});
