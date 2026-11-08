/**
 * Codex, Gemini CLI and Copilot CLI as first-class agents: the hook payloads
 * each one posts, the history files each one writes, how each reopens a
 * conversation, and the sign-in Polaris runs for each without a terminal.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { agentSignins } from "@/lib/agents/agent-signins";
import { hookConversation, normalizeHookEvent } from "@/lib/agents/session-hooks";
import { decodeCodexLine, decodeGeminiLine, transcriptDecoder } from "@/lib/agents/transcript-decoders";
import {
    CREDENTIAL_FILE_MAX,
    LOGIN_COMMANDS,
    assistedSignins,
    canAssistSignin,
    credentialFileScript,
    parseCredentialFile,
    signinCredentialFile,
    signinFirstRun,
    signinInstall
} from "@/lib/agents/signin-runtime";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("hook events from the other agents", () => {
    it("reads Gemini CLI's tool and turn events", () => {
        expect(normalizeHookEvent({ hook_event_name: "BeforeTool", tool_name: "run_shell_command" })).toMatchObject({
            kind: "tool.start",
            subject: "run_shell_command"
        });
        expect(normalizeHookEvent({ hook_event_name: "AfterAgent" })?.kind).toBe("turn.end");
        expect(normalizeHookEvent({ hook_event_name: "BeforeAgent", prompt: "fix the build" })).toMatchObject({
            kind: "prompt",
            detail: "fix the build"
        });
    });

    it("tells Gemini CLI's approval prompt apart from any other notice", () => {
        expect(
            normalizeHookEvent({
                hook_event_name: "Notification",
                notification_type: "ToolPermission",
                message: "Allow write_file?"
            })
        ).toMatchObject({ kind: "permission", detail: "Allow write_file?" });
    });

    it("reads Copilot CLI's camelCase events and string arguments", () => {
        const event = normalizeHookEvent({
            hook_event_name: "preToolUse",
            toolName: "Bash",
            toolArgs: JSON.stringify({ command: "npm test" })
        });
        expect(event).toMatchObject({ kind: "tool.start", subject: "Bash" });
        expect(event?.detail).toContain("npm test");
        // Arguments that are not JSON are no arguments, not a crash.
        expect(normalizeHookEvent({ hook_event_name: "postToolUse", toolName: "Bash", toolArgs: "{" })).toMatchObject({
            kind: "tool.end",
            subject: "Bash"
        });
    });

    it("says Copilot CLI's error, which arrives as an object", () => {
        expect(
            normalizeHookEvent({ hook_event_name: "errorOccurred", error: { message: "rate limited" } })
        ).toMatchObject({ kind: "turn.failed", detail: "rate limited" });
    });

    it("maps Codex's interrupt to the end of a turn", () => {
        expect(normalizeHookEvent({ hook_event_name: "Interrupt" })?.kind).toBe("turn.end");
    });

    it("still ignores what it does not know", () => {
        expect(normalizeHookEvent({ hook_event_name: "somethingNew" })).toBeNull();
        expect(normalizeHookEvent("BeforeTool")).toBeNull();
    });

    it("finds the conversation under either spelling of its id", () => {
        expect(hookConversation({ sessionId: "abc-123" }).vendorSessionId).toBe("abc-123");
        expect(hookConversation({ session_id: "abc_456" }).vendorSessionId).toBe("abc_456");
        expect(hookConversation({ sessionId: "has spaces" }).vendorSessionId).toBeNull();
    });
});

describe("history from Codex and Gemini CLI", () => {
    it("picks the decoder by tool, and none for one without a history file", () => {
        expect(transcriptDecoder("codex")).toBe(decodeCodexLine);
        expect(transcriptDecoder("gemini")).toBe(decodeGeminiLine);
        expect(transcriptDecoder("copilot")).toBeNull();
    });

    it("reads a Codex rollout's messages, calls and outputs", () => {
        const at = "2026-11-08T10:00:00.000Z";
        const user = decodeCodexLine(
            JSON.stringify({
                timestamp: at,
                type: "response_item",
                payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }
            })
        );
        expect(user).toHaveLength(1);
        expect(user[0]).toMatchObject({ role: "user", kind: "text", body: "hello", at: Date.parse(at) });

        const call = decodeCodexLine(
            JSON.stringify({
                type: "response_item",
                payload: {
                    type: "function_call",
                    name: "shell",
                    call_id: "call_1",
                    arguments: JSON.stringify({ command: ["ls"] })
                }
            })
        );
        expect(call[0]).toMatchObject({ kind: "tool", subject: "shell", ref: "call_1" });

        const output = decodeCodexLine(
            JSON.stringify({
                type: "response_item",
                payload: { type: "function_call_output", call_id: "call_1", output: "a.txt" }
            })
        );
        expect(output[0]).toMatchObject({ kind: "result", ref: "call_1" });
    });

    it("leaves out what Codex injects into the conversation itself", () => {
        const injected = decodeCodexLine(
            JSON.stringify({
                type: "response_item",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }]
                }
            })
        );
        expect(injected).toEqual([]);
    });

    it("marks a Codex compaction and an aborted turn, and ignores metadata", () => {
        expect(decodeCodexLine(JSON.stringify({ type: "compacted", payload: {} }))[0]).toMatchObject({
            kind: "marker",
            subject: "compacted"
        });
        expect(
            decodeCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } }))[0]
        ).toMatchObject({ kind: "marker", subject: "interrupted" });
        expect(decodeCodexLine(JSON.stringify({ type: "session_meta", payload: {} }))).toEqual([]);
        expect(decodeCodexLine("not json")).toEqual([]);
    });

    it("gives a re-read Codex line the same id, so it adds nothing", () => {
        const line = JSON.stringify({
            type: "response_item",
            payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }
        });
        expect(decodeCodexLine(line)[0]?.vendorId).toBe(decodeCodexLine(line)[0]?.vendorId);
    });

    it("reads a Gemini CLI message with its tool calls and results", () => {
        const rows = decodeGeminiLine(
            JSON.stringify({
                id: "m1",
                timestamp: "2026-11-08T10:00:00.000Z",
                type: "gemini",
                content: "Looking.",
                toolCalls: [
                    {
                        id: "t1",
                        name: "read_file",
                        displayName: "ReadFile",
                        args: { path: "a.ts" },
                        result: [{ functionResponse: { response: { output: "contents" } } }],
                        status: "success"
                    }
                ]
            })
        );
        expect(rows.map((row) => row.kind)).toEqual(["text", "tool", "result"]);
        expect(rows[0]).toMatchObject({ role: "agent", vendorId: "m1:text" });
        expect(rows[1]).toMatchObject({ subject: "ReadFile", ref: "t1", vendorId: "m1:tool:t1" });
        expect(rows[2]).toMatchObject({ body: "contents", subject: "" });
    });

    it("keeps ids stable when Gemini CLI appends the same message again", () => {
        const first = decodeGeminiLine(
            JSON.stringify({ id: "m2", type: "gemini", content: "x", toolCalls: [{ id: "t", name: "ls" }] })
        );
        const again = decodeGeminiLine(
            JSON.stringify({
                id: "m2",
                type: "gemini",
                content: "x",
                toolCalls: [{ id: "t", name: "ls", result: "out", status: "error" }]
            })
        );
        expect(again.slice(0, 2).map((row) => row.vendorId)).toEqual(first.map((row) => row.vendorId));
        expect(again[2]).toMatchObject({ kind: "result", subject: "error" });
    });

    it("says nothing for Gemini CLI's metadata line", () => {
        expect(decodeGeminiLine(JSON.stringify({ sessionId: "s", projectHash: "h" }))).toEqual([]);
    });
});

describe("reopening a conversation", () => {
    it("knows how each tool resumes, and leaves the unverified one alone", () => {
        expect(core.agentResumeStyle("claude")).toBe("flag");
        expect(core.agentResumeStyle("codex")).toBe("subcommand");
        expect(core.agentResumeStyle("gemini")).toBe("flag");
        expect(core.agentResumeStyle("copilot")).toBe("");
    });
});

describe("the sign-in command table", () => {
    it("names a catalogue tool that declares each credential it signs in", () => {
        for (const [env, login] of Object.entries(LOGIN_COMMANDS)) {
            const cli = core.AGENT_CLIS.find((one) => one.id === login.cli);
            expect(cli, env).toBeDefined();
            expect(cli?.credentials.some((credential) => credential.env === env), env).toBe(true);
            expect(signinInstall(env), env).not.toBe("");
            expect(login.command, env).not.toMatch(/[\n\r]/);
        }
    });

    it("runs the documented headless logins", () => {
        expect(LOGIN_COMMANDS.CODEX_CHATGPT_AUTH?.command).toContain("login --device-auth");
        expect(LOGIN_COMMANDS.CODEX_CHATGPT_AUTH?.command).toContain('cli_auth_credentials_store="file"');
        expect(LOGIN_COMMANDS.COPILOT_DEVICE_AUTH?.command).toBe("copilot login --device-code");
        expect(LOGIN_COMMANDS.GEMINI_GOOGLE_AUTH?.command).toBe("NO_BROWSER=true gemini");
    });

    it("offers every one of them on the screen", () => {
        const offered = assistedSignins().map((signin) => signin.env);
        for (const env of Object.keys(LOGIN_COMMANDS)) expect(offered).toContain(env);
        expect(canAssistSignin("GEMINI_API_KEY")).toBe(false);
    });

    it("installs from the catalogue unless a login says otherwise", () => {
        expect(signinInstall("GEMINI_GOOGLE_AUTH")).toBe("npm install -g @google/gemini-cli");
        expect(signinInstall("CLAUDE_CODE_OAUTH_TOKEN")).toContain("--allow-scripts");
        expect(signinInstall("NOT_A_LOGIN")).toBe("");
    });

    it("knows which logins leave a file, and where", () => {
        expect(signinCredentialFile("CODEX_CHATGPT_AUTH")).toBe(".codex/auth.json");
        expect(signinCredentialFile("GEMINI_GOOGLE_AUTH")).toBe(".gemini/oauth_creds.json");
        expect(signinCredentialFile("COPILOT_DEVICE_AUTH")).toBe(".copilot/config.json");
        expect(signinCredentialFile("CLAUDE_CODE_OAUTH_TOKEN")).toBeNull();
        const byEnv = new Map(agentSignins().map((signin) => [signin.env, signin.file]));
        expect(byEnv.get("CODEX_CHATGPT_AUTH")).toBe(".codex/auth.json");
        expect(byEnv.get("CLAUDE_CODE_OAUTH_TOKEN")).toBeNull();
    });

    it("selects Google sign-in for Gemini's login, on top of its own first run", () => {
        const answers = signinFirstRun("GEMINI_GOOGLE_AUTH");
        expect(answers).toContainEqual({
            file: ".gemini/settings.json",
            assert: { security: { auth: { selectedType: "oauth-personal" } } }
        });
        expect(answers.length).toBeGreaterThan(1);
    });
});

describe("keeping a login that is a file", () => {
    it("reads the file as the agent, from the mounted home, with the path quoted", () => {
        const script = credentialFileScript(".codex/auth.json");
        expect(script).toContain("as_agent");
        expect(script).toContain("$POLARIS_HOME");
        expect(script).toContain("base64 -w0");
        expect(script).toContain(".codex/auth.json");
    });

    it("keeps a JSON object as its base64", () => {
        const value = b64('{"tokens":{"refresh_token":"r"}}');
        expect(parseCredentialFile(`${value}\n`)).toBe(value);
    });

    it("keeps nothing that is not a whole JSON object", () => {
        expect(parseCredentialFile("")).toBeNull();
        expect(parseCredentialFile("polaris: no such file")).toBeNull();
        expect(parseCredentialFile(b64('{"tokens":'))).toBeNull();
        expect(parseCredentialFile(b64("[1,2]"))).toBeNull();
        expect(parseCredentialFile(b64("null"))).toBeNull();
        expect(parseCredentialFile(b64(`{"a":"${"x".repeat(CREDENTIAL_FILE_MAX)}"}`))).toBeNull();
    });

    it("fits what it keeps in a sign-in row, but never in a provider key", () => {
        const secret = b64(`{"a":"${"x".repeat(CREDENTIAL_FILE_MAX - 10)}"}`);
        const base = { name: "work", secret, expiresAt: null };
        expect(
            core.createModelKeySchema.safeParse({ ...base, provider: "agent-signin-codex-chatgpt-auth" }).success
        ).toBe(true);
        expect(core.createModelKeySchema.safeParse({ ...base, provider: "openai" }).success).toBe(false);
        expect(core.createModelKeySchema.safeParse({ ...base, provider: "openai", secret: "sk-12345678" }).success).toBe(
            true
        );
    });
});
