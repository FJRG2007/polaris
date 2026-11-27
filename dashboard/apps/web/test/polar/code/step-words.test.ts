/**
 * One table says every tool call: each tool Polaris registers has its words,
 * a step says its verb in the tense of its state with its target and what it
 * found, same-verb steps fold, and a tool nobody listed is said in words.
 */

import { describe, expect, it } from "vitest";
import * as steps from "@/lib/polar/code-steps";
import en from "../../../messages/en-US/polar.json";
import es from "../../../messages/es-ES/polar.json";
import { NATIVE_TOOLS } from "@/lib/polar/native/tools";
import { FIND_TOOLS } from "@/lib/polar/tool-relevance";
import { groupWords, stepWords, toolLine } from "@/lib/polar/step-words";

type Catalog = Record<string, unknown>;

/** A translator over the real catalog, enough for plain and plural messages. */
function translator(catalog: Catalog) {
    return ((key: string, values: Record<string, string | number> = {}) => {
        const found = key.split(".").reduce<unknown>((node, part) => (node as Catalog | undefined)?.[part], catalog);
        if (typeof found !== "string") throw new Error(`missing ${key}`);
        const count = Number(values.count);
        const text = found.replace(
            /\{count, plural, one \{([^}]*)\} other \{([^}]*)\}\}/,
            (_, one: string, other: string) => (count === 1 ? one : other)
        );
        return text.replace(/#/g, String(count)).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
    }) as never;
}

const t = translator(en as Catalog);

const step = (name: string, input = "", state: steps.CodeStepState = "done", output = ""): steps.CodeToolStep => ({
    name,
    kind: steps.stepKindOf(name),
    input,
    output,
    state,
    ms: 100
});

describe("the step table", () => {
    it("has words for every tool Polaris' own agent registers", () => {
        const missing = NATIVE_TOOLS.map((tool) => tool.name).filter((name) => steps.stepVerbOf(name) === "other");
        expect(missing).toEqual([]);
    });

    it("hides Polar's and Claude Code's tool lookups", () => {
        expect(steps.isHiddenStep({ name: FIND_TOOLS })).toBe(true);
        expect(steps.isHiddenStep({ name: "ToolSearch" })).toBe(true);
        expect(steps.isHiddenStep({ name: "Read" })).toBe(false);
    });

    it("has every verb's words in English and Spanish, in both tenses", () => {
        for (const catalog of [en, es] as Catalog[]) {
            const say = translator(catalog);
            for (const verb of steps.CODE_STEP_VERBS) {
                if (verb === "other" || verb === "meta") continue;
                for (const state of ["running", "done"] as const) {
                    expect(() => stepWords(say, step(verb === "command" ? "Bash" : nameFor(verb), "x", state))).not.toThrow();
                    expect(() => stepWords(say, step(nameFor(verb), "", state))).not.toThrow();
                }
            }
            for (const verb of steps.GROUPED_VERBS)
                expect(() => groupWords(say, verb, [step(nameFor(verb), "a b"), step(nameFor(verb), "c d")])).not.toThrow();
        }
    });
});

/** A tool name the table maps to a verb. */
function nameFor(verb: steps.CodeStepVerb): string {
    return Object.entries(steps.STEP_TOOLS).find(([, value]) => value === verb)![0];
}

describe("stepWords", () => {
    it("says a running step in the present and a finished one in the past", () => {
        expect(stepWords(t, step("WebSearch", "polaris distance", "running")).label).toBe("Searching the web");
        expect(stepWords(t, step("WebSearch", "polaris distance")).label).toBe("Searched the web");
        expect(toolLine(t, "Bash", "running", "npm test")).toBe("Running npm test");
        expect(toolLine(t, "Bash", "done", "npm test")).toBe("Ran npm test");
    });

    it("names the target: a file by its name, a site by its host, a command's first line", () => {
        expect(stepWords(t, step("Read", "src/lib/plan.ts")).target).toEqual({ file: "plan.ts", whole: "src/lib/plan.ts" });
        expect(stepWords(t, step("WebFetch", "https://www.example.com/a/b")).target).toEqual({
            text: "example.com",
            whole: "https://www.example.com/a/b"
        });
        expect(stepWords(t, step("Bash", "npm test\nnpm run lint")).target).toEqual({
            code: "npm test",
            whole: "npm test\nnpm run lint"
        });
        expect(stepWords(t, step("Read", "")).label).toBe("Read a file");
        expect(stepWords(t, step("Edit", '{"a":1}')).target).toBeNull();
    });

    it("counts what a finished step found", () => {
        expect(stepWords(t, step("Grep", "foo", "done", "Found 12 files\na.ts")).result).toBe("12 matches");
        expect(stepWords(t, step("Glob", "*.ts", "done", "a.ts\nb.ts")).result).toBe("2 files");
        expect(stepWords(t, step("Glob", "*.rs", "done", "No files found")).result).toBe("No matches");
        expect(stepWords(t, step("Read", "a.ts", "done", "1\tone\n2\ttwo\n3\tthree")).result).toBe("3 lines");
        expect(
            stepWords(t, step("WebSearch", "q", "done", "https://a.com/x https://b.org/y https://a.com/x")).result
        ).toBe("2 sources");
        expect(stepWords(t, step("Grep", "foo", "running")).result).toBeNull();
    });

    it("says a tool the table does not know in words, never by its id", () => {
        expect(steps.humanToolName("mcp__github__create_issue")).toEqual({ label: "Create issue", source: "Github" });
        expect(steps.humanToolName("ListPullRequests").label).toBe("List pull requests");
        expect(steps.humanToolName("polar_search_tasks").label).toBe("Polar search tasks");
        expect(steps.humanToolName("Searching for files").label).toBe("Searching for files");
        const words = stepWords(t, step("mcp__linear__get_issue", "{}"));
        expect(words.label).toBe("Get issue");
        expect(words.target).toEqual({ text: "Linear", whole: "Linear" });
    });
});

describe("groupSteps", () => {
    const entry = (name: string, input: string, state: steps.CodeStepState = "done") => ({ step: step(name, input, state) });

    it("folds consecutive finished steps of one verb and keeps the rest a row each", () => {
        const runs = steps.groupSteps([
            entry("Read", "a.ts"),
            entry("Read", "b.ts"),
            entry("ToolSearch", "select:Read"),
            entry("Read", "c.ts"),
            entry("Bash", "npm test"),
            entry("Grep", "foo"),
            entry("Grep", "bar", "running")
        ]);
        expect(runs.map((run) => (run.kind === "group" ? `${run.verb}x${run.entries.length}` : run.entry.step.name))).toEqual([
            "readx3",
            "Bash",
            "Grep",
            "Grep"
        ]);
    });

    it("never folds a failed step or a line that is not a step", () => {
        const runs = steps.groupSteps([entry("Read", "a.ts"), entry("Read", "b.ts", "failed"), { step: undefined }]);
        expect(runs.every((run) => run.kind === "one")).toBe(true);
    });

    it("says a fold by its count, or by the one file it kept touching", () => {
        expect(groupWords(t, "read", [step("Read", "a.ts"), step("Read", "src/b.ts")]).label).toBe("Read 2 files");
        expect(groupWords(t, "grep", [step("Grep", "foo"), step("Grep", "bar")]).label).toBe("Searched the code 2 times");
        const same = groupWords(t, "edit", [step("Edit", "src/a.ts"), step("Edit", "src/a.ts")]);
        expect(same.label).toBe("Edited");
        expect(same.target).toEqual({ file: "a.ts", whole: "src/a.ts" });
    });
});
