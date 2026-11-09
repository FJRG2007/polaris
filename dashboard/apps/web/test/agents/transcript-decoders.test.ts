/**
 * Claude Code transcript lines, shaped as Claude Code writes them, into the rows
 * the session page shows.
 */

import { describe, expect, it } from "vitest";
import {
    MAX_TEXT_CHARS,
    MAX_TOOL_RESULT_CHARS,
    decodeClaudeLine,
    promptKey,
    toolInputSummary,
    transcriptDecoder
} from "@/lib/agents/transcript-decoders";

const base = {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "/session/repo",
    sessionId: "6f1c2a9e-0d4b-4c8e-9a51-2b7d3e8f1a00",
    version: "2.0.14",
    gitBranch: "polaris/fix-login",
    timestamp: "2026-11-07T10:00:00.000Z"
};
const line = (record: Record<string, unknown>) => JSON.stringify({ ...base, ...record });
const AT = Date.parse(base.timestamp);

describe("decodeClaudeLine", () => {
    it("reads a prompt typed in the terminal", () => {
        const rows = decodeClaudeLine(
            line({
                type: "user",
                uuid: "u-1",
                message: { role: "user", content: "fix the login bug" }
            })
        );
        expect(rows).toEqual([
            {
                vendorId: "u-1:0",
                role: "user",
                kind: "text",
                subject: "",
                ref: "",
                body: "fix the login bug",
                at: AT
            }
        ]);
    });

    it("keeps an assistant reply and its tool call, and drops the thinking", () => {
        const rows = decodeClaudeLine(
            line({
                type: "assistant",
                uuid: "a-1",
                message: {
                    id: "msg_01",
                    role: "assistant",
                    model: "claude-sonnet-4-5",
                    content: [
                        { type: "thinking", thinking: "the user wants...", signature: "sig" },
                        { type: "text", text: "Let me look at the handler." },
                        {
                            type: "tool_use",
                            id: "toolu_01",
                            name: "Bash",
                            input: {
                                command: "npm test -- auth",
                                description: "Run the auth tests"
                            }
                        }
                    ]
                }
            })
        );
        expect(rows).toEqual([
            {
                vendorId: "a-1:1",
                role: "agent",
                kind: "text",
                subject: "",
                ref: "",
                body: "Let me look at the handler.",
                at: AT
            },
            {
                vendorId: "a-1:2",
                role: "agent",
                kind: "tool",
                subject: "Bash",
                ref: "toolu_01",
                body: "npm test -- auth",
                at: AT
            }
        ]);
    });

    it("reads a tool result, bounded, and marks a failed one", () => {
        const rows = decodeClaudeLine(
            line({
                type: "user",
                uuid: "u-2",
                toolUseResult: { stdout: "..." },
                message: {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "toolu_01",
                            content: [
                                { type: "text", text: "x".repeat(MAX_TOOL_RESULT_CHARS + 500) }
                            ],
                            is_error: true
                        }
                    ]
                }
            })
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: "result",
            ref: "toolu_01",
            subject: "error",
            role: "agent"
        });
        expect(rows[0]!.body.length).toBe(MAX_TOOL_RESULT_CHARS);
    });

    it("turns a slash command into what was typed and skips its echoed output", () => {
        const command = decodeClaudeLine(
            line({
                type: "user",
                uuid: "u-3",
                message: {
                    role: "user",
                    content:
                        "<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>auth.ts</command-args>"
                }
            })
        );
        // <command-message> leads, so it is the injected echo of the command.
        expect(command).toEqual([]);
        const typed = decodeClaudeLine(
            line({
                type: "user",
                uuid: "u-4",
                message: {
                    role: "user",
                    content: "<command-name>/compact</command-name>\n<command-args></command-args>"
                }
            })
        );
        expect(typed.map((one) => one.body)).toEqual(["/compact"]);
        const stdout = decodeClaudeLine(
            line({
                type: "user",
                uuid: "u-5",
                message: {
                    role: "user",
                    content: "<local-command-stdout>Compacted</local-command-stdout>"
                }
            })
        );
        expect(stdout).toEqual([]);
    });

    it("marks a compaction and an interruption, and skips the summary and meta turns", () => {
        expect(
            decodeClaudeLine(
                line({
                    type: "system",
                    subtype: "compact_boundary",
                    uuid: "s-1",
                    content: "Conversation compacted"
                })
            )
        ).toEqual([
            {
                vendorId: "s-1:0",
                role: "system",
                kind: "marker",
                subject: "compacted",
                ref: "",
                body: "",
                at: AT
            }
        ]);
        expect(
            decodeClaudeLine(
                line({
                    type: "user",
                    uuid: "u-6",
                    isCompactSummary: true,
                    message: { role: "user", content: "This session is being continued..." }
                })
            )
        ).toEqual([]);
        expect(
            decodeClaudeLine(
                line({
                    type: "user",
                    uuid: "u-7",
                    message: {
                        role: "user",
                        content: [
                            { type: "text", text: "[Request interrupted by user for tool use]" }
                        ]
                    }
                })
            )
        ).toMatchObject([{ kind: "marker", subject: "interrupted" }]);
        expect(
            decodeClaudeLine(
                line({
                    type: "user",
                    uuid: "u-8",
                    isMeta: true,
                    message: { role: "user", content: "Caveat: ..." }
                })
            )
        ).toEqual([]);
    });

    it("skips what it does not know, a subagent's turns, and lines without an id", () => {
        for (const bad of [
            "not json",
            "[]",
            line({ type: "summary", summary: "Login fix", leafUuid: "x" }),
            line({ type: "file-history-snapshot", messageId: "m" }),
            line({
                type: "assistant",
                uuid: "a-2",
                isSidechain: true,
                message: { content: [{ type: "text", text: "sub" }] }
            }),
            line({ type: "user", message: { role: "user", content: "no uuid" } }),
            line({
                type: "assistant",
                uuid: "a-3",
                message: { content: [{ type: "image", source: {} }] }
            })
        ])
            expect(decodeClaudeLine(bad)).toEqual([]);
    });

    it("caps a long reply", () => {
        const [row] = decodeClaudeLine(
            line({
                type: "assistant",
                uuid: "a-4",
                message: { content: [{ type: "text", text: "w".repeat(MAX_TEXT_CHARS * 2) }] }
            })
        );
        expect(row!.body.length).toBe(MAX_TEXT_CHARS);
    });
});

describe("tool inputs and decoders", () => {
    it("summarise a tool by what a person would recognise", () => {
        expect(toolInputSummary({ file_path: "/session/repo/src/auth.ts", old_string: "a" })).toBe(
            "/session/repo/src/auth.ts"
        );
        expect(toolInputSummary({ pattern: "TODO", path: "src" })).toBe("TODO");
        expect(toolInputSummary({ todos: [1] })).toBe('{"todos":[1]}');
        expect(toolInputSummary(null)).toBe("");
    });

    it("exist for the tools whose transcript format is sourced", () => {
        expect(transcriptDecoder("claude")).toBe(decodeClaudeLine);
        expect(transcriptDecoder("codex")).not.toBeNull();
        expect(transcriptDecoder("gemini")).not.toBeNull();
        expect(transcriptDecoder("custom")).toBeNull();
    });
});

describe("line time", () => {
    it("is null when the line has none or an unreadable one", () => {
        const [missing] = decodeClaudeLine(
            JSON.stringify({ type: "user", uuid: "u-9", message: { content: "hi" } })
        );
        const [garbled] = decodeClaudeLine(
            line({ type: "user", uuid: "u-8", timestamp: "soon", message: { content: "hi" } })
        );
        expect(missing?.at).toBeNull();
        expect(garbled?.at).toBeNull();
    });
});

describe("promptKey", () => {
    it("matches a prompt to the transcript's copy of it", () => {
        expect(promptKey("first line\r\nsecond  line ")).toBe(promptKey("first line\nsecond line"));
        expect(promptKey("/review  main")).toBe(promptKey("/review main"));
    });

    it("matches a long prompt to its clipped copy", () => {
        const typed = "word ".repeat(MAX_TEXT_CHARS / 2);
        const [row] = decodeClaudeLine(
            line({ type: "user", uuid: "u-7", message: { content: typed } })
        );
        expect(row!.body.length).toBeLessThan(typed.length);
        expect(promptKey(row!.body)).toBe(promptKey(typed));
    });

    it("tells different prompts apart", () => {
        expect(promptKey("fix the login bug")).not.toBe(promptKey("fix the logout bug"));
    });
});
