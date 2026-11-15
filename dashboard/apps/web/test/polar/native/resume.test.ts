/**
 * A native conversation read back from its own transcript (resume and fork),
 * and the `polaris-agent` command line.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { replayTranscript } from "@/lib/polar/native/resume";
import { TranscriptWriter } from "@/lib/polar/native/transcript";
import { nativeBundleDir } from "@/lib/polar/native/bundle";
import { conversationOf, parseArgs, pasteState } from "@/lib/polar/native/main";
import type { LaunchConfig } from "@/lib/polar/native/launch";

function written(build: (writer: TranscriptWriter) => void): string {
    const lines: string[] = [];
    build(new TranscriptWriter("conv-1", () => "/w", (line) => lines.push(line)));
    return lines.join("\n");
}

describe("replayTranscript", () => {
    it("rebuilds user, assistant, tool calls and results in order", () => {
        const text = written((w) => {
            w.user("Fix it");
            w.assistant([{ type: "text", text: "Reading." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/a" } }], "m");
            w.toolResults([{ type: "tool_result", tool_use_id: "t1", content: "1\tx" }]);
            w.assistant([{ type: "text", text: "Done." }], "m");
        });
        const messages = replayTranscript(text);
        expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        const tool = messages[2] as { content: { toolName: string; output: { value: string } }[] };
        expect(tool.content[0]?.toolName).toBe("Read");
        expect(tool.content[0]?.output.value).toBe("1\tx");
    });

    it("starts from the last compaction's summary and skips sidechains", () => {
        const lines: string[] = [];
        const main = new TranscriptWriter("c", () => "/w", (line) => lines.push(line));
        const side = new TranscriptWriter("c", () => "/w", (line) => lines.push(line), true);
        main.user("old request");
        main.compacted("Summary of before");
        side.user("subagent work");
        main.user("next");
        const messages = replayTranscript(lines.join("\n"));
        expect(messages).toEqual([
            { role: "user", content: "Summary of before" },
            { role: "user", content: "next" }
        ]);
    });

    it("closes a call an interruption left open, and skips malformed lines", () => {
        const text = written((w) => {
            w.user("go");
            w.assistant([{ type: "tool_use", id: "t9", name: "Bash", input: { command: "sleep 9" } }], "m");
            w.interrupted();
        });
        const messages = replayTranscript(`${text}\nnot json`);
        expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    });
});

describe("polaris-agent command line", () => {
    const config = { POLARIS_SESSION_ID: "s1", POLARIS_TRANSCRIPT: undefined } as unknown as LaunchConfig;

    it("parses the flags the launch script passes and refuses anything else", () => {
        expect(parseArgs(["-p", "--resume", "abc-1", "--permission-mode", "plan"])).toEqual({
            oneTurn: true,
            resume: "abc-1",
            fork: false,
            mode: "plan",
            model: null
        });
        expect(parseArgs(["--resume", "a;b"])).toHaveProperty("error");
        expect(parseArgs(["--permission-mode", "yolo"])).toHaveProperty("error");
        expect(parseArgs(["--bogus"])).toHaveProperty("error");
    });

    it("continues a resumed id, and forks to a new id", () => {
        expect(conversationOf(config, { oneTurn: true, resume: "abc", fork: false, mode: null, model: null }).id).toBe("abc");
        const fork = conversationOf(config, { oneTurn: true, resume: "/home/node/.polaris-agent/sessions/p.jsonl", fork: true, mode: null, model: null });
        expect(fork.id).not.toBe("p");
        expect(fork.from).toBe("/home/node/.polaris-agent/sessions/p.jsonl");
    });

    it("joins a bracketed paste into one prompt", () => {
        let state = pasteState("\u001b[200~line one", false);
        expect(state).toEqual({ text: "line one", inPaste: true });
        state = pasteState("line two\u001b[201~", state.inPaste);
        expect(state).toEqual({ text: "line two", inPaste: false });
    });
});

describe("nativeBundleDir", () => {
    it("finds the bundle under the app folder of a standalone tree", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-bundle-"));
        expect(nativeBundleDir(root)).toBeNull();
        fs.mkdirSync(path.join(root, "apps", "web", "native-agent"), { recursive: true });
        fs.writeFileSync(path.join(root, "apps", "web", "native-agent", "polaris-agent.mjs"), "//");
        expect(nativeBundleDir(root)).toBe(path.join(root, "apps", "web", "native-agent"));
        fs.rmSync(root, { recursive: true, force: true });
    });
});
