import { describe, expect, it } from "vitest";
import * as asks from "@/lib/agents/session-asks";
import { claudeHookSettings, hookScript } from "@/lib/agents/session-hooks";
import { modelCommand, modePresses, permissionModeCommand } from "@/lib/agents/session-commands";

const pre = (tool: string, input: unknown) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });

describe("todo lists from hook payloads", () => {
    it("reads Claude Code's TodoWrite", () => {
        const todos = asks.readTodos(
            pre("TodoWrite", {
                todos: [
                    { content: "Write the test", status: "completed", activeForm: "Writing the test" },
                    { content: "Fix the bug", status: "in_progress" },
                    { content: "Ship", status: "pending" }
                ]
            })
        );
        expect(todos).toEqual([
            { text: "Write the test", status: "completed" },
            { text: "Fix the bug", status: "in_progress" },
            { text: "Ship", status: "pending" }
        ]);
    });

    it("reads Codex's update_plan and Gemini CLI's write_todos, dropping cancelled steps", () => {
        expect(asks.readTodos(pre("update_plan", { plan: [{ step: "Read", status: "completed" }] }))).toEqual([
            { text: "Read", status: "completed" }
        ]);
        expect(
            asks.readTodos({
                hook_event_name: "BeforeTool",
                tool_name: "write_todos",
                tool_input: { todos: [{ description: "A", status: "cancelled" }, { description: "B", status: "pending" }] }
            })
        ).toEqual([{ text: "B", status: "pending" }]);
    });

    it("ignores other tools, other events and malformed lists", () => {
        expect(asks.readTodos(pre("Bash", { command: "ls" }))).toBeNull();
        expect(asks.readTodos({ ...pre("TodoWrite", { todos: [] }), hook_event_name: "PostToolUse" })).toBeNull();
        expect(asks.readTodos(pre("TodoWrite", { todos: "nope" }))).toBeNull();
        expect(asks.storedTodos([{ text: "x", status: "weird" }, { text: "y", status: "pending" }])).toEqual([
            { text: "y", status: "pending" }
        ]);
    });
});

describe("questions and plans", () => {
    const questions = [
        {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React", description: "Components" }, { label: "Vue" }],
            multiSelect: false
        }
    ];

    it("reads an AskUserQuestion call and answers it with updatedInput", () => {
        const read = asks.readAsk(pre("AskUserQuestion", { questions }));
        expect(read?.ask).toEqual({ kind: "question", questions });
        const out = asks.askDecision("AskUserQuestion", "allow", read!.raw, {
            answers: { "Which framework?": "React" }
        });
        expect(out).toEqual({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: { questions, answers: { "Which framework?": "React" } }
            }
        });
    });

    it("skips a question as a deny with a reason, and leaves an unanswered one to the terminal", () => {
        const skipped = asks.askDecision("AskUserQuestion", "deny", { questions }, {});
        expect(skipped).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
        expect(asks.askDecision("AskUserQuestion", "expired", { questions }, null)).toEqual({});
        expect(asks.askDecision("AskUserQuestion", "pending", { questions }, null)).toEqual({});
    });

    it("reads ExitPlanMode's plan; approve echoes it, keep planning carries the feedback", () => {
        const read = asks.readAsk(pre("ExitPlanMode", { plan: "## Plan\n1. Do it", planFilePath: "/tmp/p.md" }));
        expect(read?.ask).toEqual({ kind: "plan", plan: "## Plan\n1. Do it", planFilePath: "/tmp/p.md" });
        expect(asks.askDecision("ExitPlanMode", "allow", read!.raw, {})).toEqual({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: { plan: "## Plan\n1. Do it", planFilePath: "/tmp/p.md" }
            }
        });
        const back = asks.askDecision("ExitPlanMode", "deny", read!.raw, { feedback: "Add tests" }) as {
            hookSpecificOutput: { permissionDecisionReason: string };
        };
        expect(back.hookSpecificOutput.permissionDecisionReason).toContain("Add tests");
    });

    it("refuses what does not fit the schema", () => {
        expect(asks.readAsk(pre("AskUserQuestion", { questions: [] }))).toBeNull();
        expect(asks.readAsk(pre("ExitPlanMode", {}))).toBeNull();
        expect(asks.readAsk({ ...pre("AskUserQuestion", { questions }), hook_event_name: "PermissionRequest" })).toBeNull();
        expect(asks.isAskTool("ExitPlanMode")).toBe(true);
        expect(asks.isAskTool("Bash")).toBe(false);
    });
});

describe("permission modes", () => {
    it("reads the mode every hook reports", () => {
        expect(asks.reportedPermissionMode({ permission_mode: "acceptEdits" })).toBe("edits");
        expect(asks.reportedPermissionMode({ permission_mode: "default" })).toBe("ask");
        expect(asks.reportedPermissionMode({ permission_mode: "auto" })).toBeNull();
        expect(asks.reportedPermissionMode({})).toBeNull();
    });

    it("counts Shift+Tab presses around the cycle", () => {
        expect(modePresses("ask", "plan")).toBe(2);
        expect(modePresses("full", "ask")).toBe(1);
        expect(modePresses("plan", "plan")).toBe(0);
        expect(modePresses(null, "plan")).toBe(0);
    });

    it("writes the mode for the next turn and presses only for an open interface", () => {
        const command = permissionModeCommand("/state", "plan", 2);
        expect(command).toContain('printf %s plan > "/state/permission-mode"');
        expect(command).toContain("send-keys");
        expect(command).toContain("BTab BTab");
        expect(() => permissionModeCommand("/state", "plan; rm", 1)).toThrow();
    });
});

describe("hooks wait for a question or a plan", () => {
    it("gives PreToolUse the long timeout and asks for those two tools only", () => {
        const settings = claudeHookSettings("/hook.sh") as {
            hooks: Record<string, { hooks: { timeout: number }[] }[]>;
        };
        expect(settings.hooks.PreToolUse![0]!.hooks[0]!.timeout).toBeGreaterThan(100);
        const script = hookScript("https://x/ingest", "token", "https://x/ask");
        expect(script).toContain("AskUserQuestion|ExitPlanMode");
        expect(script).toContain('"PreToolUse"');
    });
});

describe("Claude Code's task tools, one task at a time", () => {
    const post = (tool: string, input: unknown, response?: unknown) => ({
        hook_event_name: "PostToolUse",
        tool_name: tool,
        tool_input: input,
        tool_response: response
    });

    it("adds a created task with the id the response gives, else the next number", () => {
        const one = asks.applyTaskTool(post("TaskCreate", { subject: "Write the test", description: "x" }, { task: { id: "1" } }), []);
        expect(one).toEqual([{ id: "1", text: "Write the test", status: "pending" }]);
        const two = asks.applyTaskTool(post("TaskCreate", { subject: "Ship" }, "done"), one!);
        expect(two?.at(-1)).toEqual({ id: "2", text: "Ship", status: "pending" });
    });

    it("moves, renames and deletes a task by its id", () => {
        const list = [
            { id: "1", text: "A", status: "pending" as const },
            { id: "2", text: "B", status: "pending" as const }
        ];
        expect(asks.applyTaskTool(post("TaskUpdate", { taskId: "1", status: "in_progress" }), list)?.[0]?.status).toBe("in_progress");
        expect(asks.applyTaskTool(post("TaskUpdate", { taskId: "2", subject: "B2" }), list)?.[1]?.text).toBe("B2");
        expect(asks.applyTaskTool(post("TaskUpdate", { taskId: "1", status: "deleted" }), list)).toEqual([list[1]]);
        expect(asks.applyTaskTool(post("TaskUpdate", { taskId: "9", status: "completed" }), list)).toBeNull();
    });

    it("ignores the call before it ran and every other tool", () => {
        expect(asks.isTaskTool(pre("TaskCreate", { subject: "A" }))).toBe(false);
        expect(asks.applyTaskTool(post("TodoWrite", { todos: [] }), [])).toBeNull();
    });

    it("keeps a task's id when the list is read back", () => {
        expect(asks.storedTodos([{ id: "3", text: "A", status: "completed" }, { text: "B", status: "pending" }])).toEqual([
            { id: "3", text: "A", status: "completed" },
            { text: "B", status: "pending" }
        ]);
    });
});

describe("the model changed mid-session", () => {
    it("writes it for the next turn and types /model into an open interface", () => {
        const command = modelCommand("/state", "sonnet[1m]");
        expect(command).toContain(`printf %s 'sonnet[1m]' > "/state/model"`);
        expect(command).toContain(`-l '/model sonnet[1m]'`);
        expect(() => modelCommand("/state", "opus; rm -rf /")).toThrow();
    });
});
