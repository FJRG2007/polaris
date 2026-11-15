/**
 * What an agent keeps for the person beside its work: its todo list, the
 * questions it asks with options, and the plan it asks to have approved.
 *
 * All three arrive in hook payloads as a tool call's input. Claude Code calls
 * them TodoWrite, AskUserQuestion and ExitPlanMode
 * (https://code.claude.com/docs/en/hooks#askuserquestion); the todo tool has a
 * name of its own in each CLI (Codex `update_plan`, Gemini CLI `write_todos`,
 * opencode `todowrite`), and only Claude Code's questions and plans can be
 * answered from outside its terminal - a PreToolUse hook that returns "allow"
 * with `updatedInput` (https://code.claude.com/docs/en/hooks#tools-that-require-user-interaction).
 * The cards follow Claude Code on the web and slopus/happy: one question at a
 * time with numbered options, "1 of N", free text and Skip.
 *
 * Pure: the payload is the agent's, parsed against a schema, and everything
 * kept is cut to a bound.
 */

import { z } from "zod";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface SessionTodo {
    readonly text: string;
    readonly status: TodoStatus;
    /** The task's id, for a list kept one task at a time (TaskCreate and
     *  TaskUpdate); absent for one written whole. */
    readonly id?: string;
}

const MAX_TODOS = 50;
const MAX_TODO_CHARS = 300;
export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 9;
const MAX_PLAN_CHARS = 40_000;
export const MAX_ANSWER_CHARS = 2_000;

function clip(text: string, max: number): string {
    const flat = text.trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function inputOf(payload: unknown): { tool: string; event: string; input: Record<string, unknown> } {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    let input: unknown = record.tool_input ?? record.toolArgs;
    if (typeof input === "string") {
        try {
            input = JSON.parse(input);
        } catch {
            input = {};
        }
    }
    return {
        tool: typeof record.tool_name === "string" ? record.tool_name : typeof record.toolName === "string" ? record.toolName : "",
        event: typeof record.hook_event_name === "string" ? record.hook_event_name : "",
        input: input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
    };
}

function todoStatus(raw: unknown): TodoStatus | null {
    const value = typeof raw === "string" ? raw.toLowerCase() : "";
    if (value === "pending" || value === "todo") return "pending";
    if (value === "in_progress" || value === "in-progress" || value === "active") return "in_progress";
    if (value === "completed" || value === "done" || value === "complete") return "completed";
    // Gemini's "cancelled" and anything newer: not a step still to show.
    return null;
}

/** The tools that write a whole todo list, and where each keeps it. */
const TODO_TOOLS: Readonly<Record<string, { list: string; text: readonly string[] }>> = {
    TodoWrite: { list: "todos", text: ["content", "activeForm"] },
    todowrite: { list: "todos", text: ["content"] },
    update_plan: { list: "plan", text: ["step"] },
    write_todos: { list: "todos", text: ["description", "content"] }
};

/**
 * The todo list a hook payload writes, or null when it writes none. Read off
 * the call before it runs, so the list moves the moment the agent decides.
 */
export function readTodos(payload: unknown): SessionTodo[] | null {
    const { tool, event, input } = inputOf(payload);
    if (event && event !== "PreToolUse" && event !== "BeforeTool" && event !== "preToolUse") return null;
    const shape = TODO_TOOLS[tool];
    if (!shape) return null;
    const list = input[shape.list];
    if (!Array.isArray(list)) return null;
    const todos: SessionTodo[] = [];
    for (const item of list.slice(0, MAX_TODOS)) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        const status = todoStatus(entry.status);
        const text = shape.text.map((key) => entry[key]).find((value) => typeof value === "string" && value.trim());
        if (status && typeof text === "string") todos.push({ text: clip(text, MAX_TODO_CHARS), status });
    }
    return todos;
}

/** A stored list read back; anything that does not fit is dropped. */
export function storedTodos(raw: unknown): SessionTodo[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
        const parsed = z
            .object({
                text: z.string().max(MAX_TODO_CHARS),
                status: z.enum(TODO_STATUSES),
                id: z.string().max(MAX_TASK_ID_CHARS).optional()
            })
            .safeParse(item);
        if (!parsed.success) return [];
        const { id, ...todo } = parsed.data;
        return [id ? { ...todo, id } : todo];
    });
}

const MAX_TASK_ID_CHARS = 64;

/** Whether a payload is Claude Code's TaskCreate or TaskUpdate having run. */
export function isTaskTool(payload: unknown): boolean {
    const { tool, event } = inputOf(payload);
    return event === "PostToolUse" && (tool === "TaskCreate" || tool === "TaskUpdate");
}

/** The id Claude Code gave a task it created: off its response when it says,
 *  else the next number, which is how it numbers them. */
function createdTaskId(response: unknown, current: readonly SessionTodo[]): string {
    const record = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
    const task = record.task && typeof record.task === "object" ? (record.task as Record<string, unknown>) : record;
    const said = task.id ?? task.taskId;
    if ((typeof said === "string" && said.trim()) || typeof said === "number") return clip(String(said), MAX_TASK_ID_CHARS);
    const text = typeof response === "string" ? response : "";
    const numbered = /Task #(\d+)/.exec(text);
    if (numbered) return numbered[1]!;
    const highest = current.reduce((max, todo) => Math.max(max, Number(todo.id) || 0), 0);
    return String(highest + 1);
}

/**
 * The list after Claude Code's TaskCreate or TaskUpdate (its newer task tools,
 * which add or change one task per call rather than writing the whole list as
 * TodoWrite does), or null when the payload is neither or changes nothing.
 * Read once the call has run, because only the response carries a new task's
 * id; a task marked `deleted` leaves the list.
 */
export function applyTaskTool(payload: unknown, current: readonly SessionTodo[]): SessionTodo[] | null {
    if (!isTaskTool(payload)) return null;
    const { tool, input } = inputOf(payload);
    const record = payload as Record<string, unknown>;
    if (tool === "TaskCreate") {
        if (current.length >= MAX_TODOS) return null;
        const text = [input.subject, input.activeForm].find((value) => typeof value === "string" && value.trim());
        if (typeof text !== "string") return null;
        const id = createdTaskId(record.tool_response, current);
        return [...current, { id, text: clip(text, MAX_TODO_CHARS), status: "pending" }];
    }
    const raw = input.taskId ?? input.id;
    const id = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
    const at = current.findIndex((todo) => todo.id === id);
    if (!id || at < 0) return null;
    if (input.status === "deleted") return current.filter((_, index) => index !== at);
    const status = input.status === undefined ? current[at]!.status : todoStatus(input.status);
    const text = typeof input.subject === "string" && input.subject.trim() ? clip(input.subject, MAX_TODO_CHARS) : current[at]!.text;
    if (!status) return null;
    return current.map((todo, index) => (index === at ? { ...todo, text, status } : todo));
}

export const questionSchema = z.object({
    question: z.string().trim().min(1).max(500),
    header: z.string().trim().max(60).optional(),
    multiSelect: z.boolean().optional(),
    options: z
        .array(z.object({ label: z.string().trim().min(1).max(200), description: z.string().max(500).optional() }))
        .min(1)
        .max(MAX_OPTIONS)
});
export type AskQuestion = z.infer<typeof questionSchema>;

/** A question or a plan put to the person, as stored and shown. */
export type SessionAsk =
    | { readonly kind: "question"; readonly questions: readonly AskQuestion[] }
    | { readonly kind: "plan"; readonly plan: string; readonly planFilePath: string };

export const ASK_TOOLS = ["AskUserQuestion", "ExitPlanMode"] as const;

/**
 * The question or plan a PreToolUse payload asks to have answered, or null.
 * The input the agent sent is kept whole beside it (`raw`), because the answer
 * has to echo it back.
 */
export function readAsk(payload: unknown): { ask: SessionAsk; raw: Record<string, unknown> } | null {
    const { tool, event, input } = inputOf(payload);
    if (event !== "PreToolUse") return null;
    if (tool === "AskUserQuestion") {
        const parsed = z.array(questionSchema).min(1).max(MAX_QUESTIONS).safeParse(input.questions);
        if (!parsed.success) return null;
        return { ask: { kind: "question", questions: parsed.data }, raw: { questions: parsed.data } };
    }
    if (tool === "ExitPlanMode") {
        const plan = typeof input.plan === "string" ? input.plan : "";
        const planFilePath = typeof input.planFilePath === "string" ? input.planFilePath.slice(0, 1000) : "";
        if (!plan.trim()) return null;
        return {
            ask: { kind: "plan", plan: clip(plan, MAX_PLAN_CHARS), planFilePath },
            raw: { plan, ...(planFilePath ? { planFilePath } : {}) }
        };
    }
    return null;
}

/** Whether a permission prompt is one of these, which the PreToolUse hook
 *  already put to the person: the second ask would be the same card twice. */
export function isAskTool(tool: string): boolean {
    return (ASK_TOOLS as readonly string[]).includes(tool);
}

/** A stored ask read back, or null. */
export function storedAsk(tool: string, raw: unknown): SessionAsk | null {
    return readAsk({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: raw })?.ask ?? null;
}

export const askAnswerSchema = z.object({
    /** Question text to the chosen label(s), joined with ", " for several. */
    answers: z.record(z.string().max(500), z.string().trim().max(MAX_ANSWER_CHARS)).optional(),
    /** What to plan differently, for a plan sent back. */
    feedback: z.string().trim().max(MAX_ANSWER_CHARS).optional()
});
export type AskAnswer = z.infer<typeof askAnswerSchema>;

/**
 * The PreToolUse hook's standard output for an answered ask. `{}` for one not
 * answered: no decision, so the agent asks in its own terminal.
 */
export function askDecision(
    tool: string,
    status: string,
    raw: unknown,
    answer: unknown
): Record<string, unknown> {
    if (status !== "allow" && status !== "deny") return {};
    const said = askAnswerSchema.safeParse(answer ?? {});
    const given = said.success ? said.data : {};
    const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const out = (decision: Record<string, unknown>) => ({
        hookSpecificOutput: { hookEventName: "PreToolUse", ...decision }
    });
    if (status === "deny")
        return out({
            permissionDecision: "deny",
            permissionDecisionReason:
                tool === "ExitPlanMode"
                    ? given.feedback
                        ? `The user wants you to keep planning: ${given.feedback}`
                        : "The user wants you to keep planning before you change anything."
                    : "The user skipped these questions. Carry on with your best judgment."
        });
    if (tool === "AskUserQuestion")
        return out({ permissionDecision: "allow", updatedInput: { ...input, answers: given.answers ?? {} } });
    return out({ permissionDecision: "allow", updatedInput: input });
}

/** Claude Code's name for each mode Polaris offers, read back from the
 *  `permission_mode` every hook reports. `auto` and `dontAsk` are not offered,
 *  so they are not read. */
const REPORTED_MODES: Readonly<Record<string, "ask" | "edits" | "plan" | "full">> = {
    default: "ask",
    manual: "ask",
    acceptEdits: "edits",
    plan: "plan",
    bypassPermissions: "full"
};

/** The mode the agent says it is in now, or null when it does not say. */
export function reportedPermissionMode(payload: unknown): "ask" | "edits" | "plan" | "full" | null {
    const raw = payload && typeof payload === "object" ? (payload as Record<string, unknown>).permission_mode : null;
    return typeof raw === "string" ? (REPORTED_MODES[raw] ?? null) : null;
}
