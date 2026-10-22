/**
 * Framed prompts for tests: each question takes the next scripted answer, and
 * every question and line shown is recorded in order. `CANCEL` as an answer is
 * the person pressing Ctrl+C at that prompt.
 */

import { Cancelled, type Ui } from "../../src/ui.js";

export const CANCEL = Symbol("cancel");

export type Answer = string | boolean | null | typeof CANCEL | ((labels: string[]) => unknown);

export function fakeUi(answers: Answer[] = []): { ui: Ui; shown: string[]; left: () => number } {
    const queue = [...answers];
    const shown: string[] = [];
    const next = (kind: string, message: string, labels: string[] = []): unknown => {
        shown.push(`${kind}: ${message}`);
        if (queue.length === 0) throw new Error(`no scripted answer for ${kind} "${message}"`);
        const answer = queue.shift();
        if (answer === CANCEL) throw new Cancelled();
        return typeof answer === "function" ? answer(labels) : answer;
    };
    const ui: Ui = {
        intro: (title) => void shown.push(`intro: ${title}`),
        outro: (message) => void shown.push(`outro: ${message}`),
        note: (body, title) => void shown.push(`note: ${title ?? ""}\n${body}`),
        info: (message) => void shown.push(`info: ${message}`),
        success: (message) => void shown.push(`success: ${message}`),
        warn: (message) => void shown.push(`warn: ${message}`),
        error: (message) => void shown.push(`error: ${message}`),
        async select(message, choices) {
            const labels = choices.map((choice) => choice.label);
            const picked = next("select", message, labels);
            const choice = choices.find((each) => each.label === picked);
            if (!choice) throw new Error(`"${String(picked)}" is not one of ${labels.join(", ")}`);
            return choice.value;
        },
        confirm: async (message) => next("confirm", message) as boolean,
        async text(message, options) {
            const typed = next("text", message) as string;
            const problem = options?.validate?.(typed);
            if (problem) throw new Error(`validation refused "${typed}": ${problem}`);
            return typed;
        },
        password: async (message) => next("password", message) as string,
        spinner: () => ({
            start: (message) => void shown.push(`spinner: ${message}`),
            message: (message) => void shown.push(`spinner: ${message}`),
            stop: (message) => void shown.push(`spinner done: ${message}`),
            error: (message) => void shown.push(`spinner failed: ${message}`)
        })
    };
    return { ui, shown, left: () => queue.length };
}
