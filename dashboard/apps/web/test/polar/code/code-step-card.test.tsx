// @vitest-environment jsdom
/**
 * A Code step card says its command once - on its line while closed, whole in
 * its body once opened - and shows a command's output as the log it is,
 * without the Markdown fence the agent wrapped it in.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodeStepCard } from "@/components/polar/code-steps-view";
import type { CodeStepView, CodeToolStep } from "@/lib/polar/code-steps";

afterEach(cleanup);

const COMMAND = "which chromium firefox 2>&1 | head; ls /opt";

const command: CodeToolStep = {
    name: COMMAND,
    kind: "command",
    input: COMMAND,
    output: "```console\n/usr/bin/firefox\ngoogle\n```",
    state: "done",
    ms: 1300
};

function card(step: CodeToolStep, view: CodeStepView) {
    return render(
        <MessagesWrapper>
            <ul>
                <CodeStepCard step={step} view={view} />
            </ul>
        </MessagesWrapper>
    );
}

function times(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

describe("CodeStepCard", () => {
    it("says the command once when it opens, in its body only", () => {
        const view = card(command, "detailed");
        const button = screen.getByRole("button", { expanded: true });
        expect(button.textContent).not.toContain("chromium");
        expect(times(view.container.textContent ?? "", COMMAND)).toBe(1);
    });

    it("shows the command on its line while closed, and only there", () => {
        const view = card(command, "detailed");
        fireEvent.click(screen.getByRole("button", { expanded: true }));
        const button = screen.getByRole("button", { expanded: false });
        expect(button.textContent).toContain(COMMAND);
        expect(times(view.container.textContent ?? "", COMMAND)).toBe(1);
    });

    it("names the command on the closed line in either view, like Claude Code's Bash(npm test)", () => {
        const view = card(command, "compact");
        const button = screen.getByRole("button", { expanded: false });
        expect(button.textContent).toContain("Ran");
        expect(button.textContent).toContain(COMMAND);
        fireEvent.click(button);
        expect(times(view.container.textContent ?? "", COMMAND)).toBe(1);
    });

    it("keeps the time on the hover, not on the line", () => {
        card(command, "compact");
        const button = screen.getByRole("button", { expanded: false });
        expect(button.textContent).not.toContain("1.3 s");
        expect(button.getAttribute("title")).toContain("1.3 s");
    });

    it("says a finished search, its pattern and what it found", () => {
        const grep: CodeToolStep = { name: "Grep", kind: "search", input: "useSteps", output: "Found 12 files\na.ts", state: "done", ms: 80 };
        card(grep, "compact");
        const line = screen.getByRole("button", { expanded: false }).textContent ?? "";
        expect(line).toContain("Searched the code");
        expect(line).toContain("useSteps");
        expect(line).toContain("12 matches");
    });

    it("says a running search in the present", () => {
        const web: CodeToolStep = { name: "WebSearch", kind: "web", input: "polaris distance", output: "", state: "running", ms: null };
        card(web, "compact");
        expect(screen.getByRole("button", { expanded: false }).textContent).toContain("Searching the web");
    });

    it("never names a tool by its id", () => {
        const mcp: CodeToolStep = { name: "mcp__github__create_issue", kind: "other", input: "{}", output: "", state: "done", ms: null };
        card(mcp, "compact");
        const line = screen.getByRole("button", { expanded: false }).textContent ?? "";
        expect(line).toContain("Create issue");
        expect(line).not.toMatch(/Used|mcp__/);
    });

    it("never shows the fence an agent wraps output in", () => {
        const view = card(command, "detailed");
        const log = view.container.querySelector("pre");
        expect(log?.textContent).toBe("/usr/bin/firefox\ngoogle");
        expect(view.container.textContent).not.toContain("```");
    });

    it("puts a read file's name on the line and the whole path in the body", () => {
        const read: CodeToolStep = { name: "Read", kind: "read", input: "src/lib/plan.ts", output: "x", state: "done", ms: null };
        const view = card(read, "detailed");
        expect(screen.getByRole("button", { expanded: true }).textContent).toContain("plan.ts");
        expect(times(view.container.textContent ?? "", "src/lib/plan.ts")).toBe(1);
    });
});
