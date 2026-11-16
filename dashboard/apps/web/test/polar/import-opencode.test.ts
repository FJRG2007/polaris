/**
 * Reading an OpenCode session export into a Polar chat: both shapes OpenCode
 * has printed (typed v2 messages, and v1's `{ info, parts }`), words only,
 * tool calls as a line each, and a refusal for a damaged one.
 *
 * The fixtures follow OpenCode's own: `SessionTransfer.Data` and the CLI's
 * `test/import-export.test.ts` for v2, and v1.0.0's `cli/cmd/export.ts` with
 * `MessageV2` parts for v1.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/request", () => ({ getTranslations: vi.fn() }));
vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: {} }));

const imports = await import("@/lib/polar/import");

const model = { id: "fixture-model", providerID: "fixture-provider" };

const v2Export = {
    info: {
        id: "ses_fixture_v2",
        projectID: "global",
        cost: 0.0123,
        tokens: { input: 1200, output: 340, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1763290000000, updated: 1763290060000 },
        title: "  Fix the\nlogin form ",
        location: { directory: "/project" }
    },
    messages: [
        { id: "msg_0001", type: "model-switched", model, time: { created: 1763290000000 } },
        {
            id: "msg_0002",
            type: "user",
            text: "The login form submits twice.",
            files: [],
            agents: [],
            skills: [],
            time: { created: 1763290001000 }
        },
        {
            id: "msg_0003",
            type: "assistant",
            agent: "build",
            model,
            time: { created: 1763290002000 },
            content: [
                { type: "reasoning", text: "Look at the submit handler.", time: { created: 1763290002000 } },
                {
                    type: "tool",
                    id: "call_1",
                    name: "read",
                    state: {
                        status: "completed",
                        input: { filePath: "src/login.tsx" },
                        content: [{ type: "text", text: "export function Login() {}" }]
                    },
                    time: { created: 1763290003000, completed: 1763290003500 }
                },
                {
                    type: "tool",
                    id: "call_2",
                    name: "edit",
                    state: {
                        status: "error",
                        input: { filePath: "src/login.tsx" },
                        error: { type: "unknown", message: "no match" }
                    },
                    time: { created: 1763290004000 }
                },
                { type: "text", text: "The button had two handlers; one is gone now." }
            ],
            finish: "stop"
        },
        { id: "msg_0004", type: "synthetic", text: "Injected context", time: { created: 1763290005000 } },
        {
            id: "msg_0005",
            type: "shell",
            shellID: "sh_1",
            command: "npm test",
            status: "completed",
            time: { created: 1763290006000 }
        }
    ]
};

const v1Export = {
    info: {
        id: "ses_fixture_v1",
        version: "1.0.0",
        projectID: "global",
        directory: "/project",
        title: "Rename the helper",
        time: { created: 1750000000000, updated: 1750000060000 }
    },
    messages: [
        {
            info: { id: "msg_a1", sessionID: "ses_fixture_v1", role: "user", time: { created: 1750000001000 } },
            parts: [
                { id: "prt_1", sessionID: "ses_fixture_v1", messageID: "msg_a1", type: "text", text: "Rename util to helpers." },
                {
                    id: "prt_2",
                    sessionID: "ses_fixture_v1",
                    messageID: "msg_a1",
                    type: "text",
                    text: "<system-reminder>synthetic</system-reminder>",
                    synthetic: true
                }
            ]
        },
        {
            info: {
                id: "msg_a2",
                sessionID: "ses_fixture_v1",
                role: "assistant",
                time: { created: 1750000002000, completed: 1750000009000 },
                modelID: "fixture-model",
                providerID: "fixture-provider",
                cost: 0,
                tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }
            },
            parts: [
                { id: "prt_3", sessionID: "ses_fixture_v1", messageID: "msg_a2", type: "step-start" },
                {
                    id: "prt_4",
                    sessionID: "ses_fixture_v1",
                    messageID: "msg_a2",
                    type: "tool",
                    callID: "toolu_1",
                    tool: "bash",
                    state: {
                        status: "completed",
                        input: { command: "git mv util.ts helpers.ts" },
                        output: "",
                        title: "git mv util.ts helpers.ts",
                        metadata: {},
                        time: { start: 1750000003000, end: 1750000003100 }
                    }
                },
                {
                    id: "prt_5",
                    sessionID: "ses_fixture_v1",
                    messageID: "msg_a2",
                    type: "tool",
                    callID: "toolu_2",
                    tool: "grep",
                    state: { status: "pending", input: {}, raw: "" }
                },
                { id: "prt_6", sessionID: "ses_fixture_v1", messageID: "msg_a2", type: "text", text: "Renamed." },
                { id: "prt_7", sessionID: "ses_fixture_v1", messageID: "msg_a2", type: "step-finish", reason: "stop" }
            ]
        }
    ]
};

describe("parseThreadImport, OpenCode", () => {
    it("reads a v2 export: user text, assistant words and a line per tool call", () => {
        const parsed = imports.parseThreadImport(JSON.stringify(v2Export, null, 2));
        expect(parsed).toEqual({
            thread: {
                title: "Fix the login form",
                messages: [
                    { role: "user", parts: [{ type: "text", text: "The login form submits twice." }] },
                    {
                        role: "assistant",
                        parts: [
                            { type: "reasoning", text: "Look at the submit handler." },
                            { type: "text", text: "`read`\n`edit`" },
                            { type: "text", text: "The button had two handlers; one is gone now." }
                        ]
                    }
                ]
            }
        });
    });

    it("reads a v1 export, leaving synthetic text and steps out and naming a tool's title", () => {
        const parsed = imports.parseThreadImport(JSON.stringify(v1Export));
        expect(parsed).toEqual({
            thread: {
                title: "Rename the helper",
                messages: [
                    { role: "user", parts: [{ type: "text", text: "Rename util to helpers." }] },
                    {
                        role: "assistant",
                        parts: [
                            { type: "text", text: "`bash` - git mv util.ts helpers.ts\n`grep`" },
                            { type: "text", text: "Renamed." }
                        ]
                    }
                ]
            }
        });
    });

    it("takes the transfer as OpenCode's API answers it, inside data", () => {
        const parsed = imports.parseThreadImport(JSON.stringify({ data: v2Export }));
        expect("thread" in parsed && parsed.thread.messages).toHaveLength(2);
    });

    it("refuses a damaged export and one with nothing to bring over", () => {
        expect(imports.parseThreadImport(JSON.stringify({ info: {}, messages: [{ type: 7 }] }))).toEqual({
            refusal: "shape"
        });
        expect(
            imports.parseThreadImport(
                JSON.stringify({ info: { title: "Empty" }, messages: [{ id: "msg_1", type: "synthetic", text: "x" }] })
            )
        ).toEqual({ refusal: "empty" });
    });

    it("still refuses a file that is neither export", () => {
        expect(imports.parseThreadImport(JSON.stringify({ messages: [] }))).toEqual({ refusal: "version" });
    });
});
