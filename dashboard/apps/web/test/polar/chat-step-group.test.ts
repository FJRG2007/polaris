/**
 * Polar's chat folds its steps by the same rule as Polar Code's thread, and
 * says every browser action in both tenses with what it acted on.
 */

import { describe, expect, it } from "vitest";
import en from "../../messages/en-US/polar.json";
import es from "../../messages/es-ES/polar.json";
import { groupRuns } from "@/lib/polar/code-steps";
import { chatStepGroup } from "@/lib/polar/chat-step-group";
import { BROWSER_ACTIONS } from "@/lib/polar/browser-steps";

describe("chatStepGroup", () => {
    it("folds web searches together and keeps any other tool with itself", () => {
        expect(chatStepGroup("web_search", { query: "a" })).toBe("webSearch");
        expect(chatStepGroup("web_search", { query: "b" })).toBe(chatStepGroup("web_search", { query: "a" }));
        expect(chatStepGroup("read_tasks", {})).toBe("tool:read_tasks");
        expect(chatStepGroup("read_tasks", {})).not.toBe(chatStepGroup("read_notes", {}));
    });
});

describe("groupRuns", () => {
    it("folds consecutive items with one key; a null key stands alone", () => {
        const runs = groupRuns(["a", "a", "b", "x", "a", "a"], (item) => (item === "x" ? null : item));
        expect(runs.map((run) => (run.kind === "group" ? `${run.key}x${run.entries.length}` : run.entry))).toEqual([
            "ax2",
            "b",
            "x",
            "ax2"
        ]);
    });
});

describe("browser steps", () => {
    it("say every action running and done, in English and Spanish", () => {
        for (const catalog of [en, es]) {
            const steps = catalog.web.browserSteps as Record<string, { running?: string; done?: string }>;
            for (const action of new Set([...BROWSER_ACTIONS, "close"])) {
                expect(steps[action]?.running, `${action} running`).toBeTruthy();
                expect(steps[action]?.done, `${action} done`).toBeTruthy();
                expect(steps[action]!.running).not.toBe(steps[action]!.done);
            }
        }
    });
});
