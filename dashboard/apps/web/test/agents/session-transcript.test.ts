/**
 * Tailing an agent's transcript through the 16 KiB exec cap: the scripts are
 * run for real with `sh` against a throwaway file, so the chunking, the base64
 * round trip and the line boundaries are the ones a machine would produce.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import {
    MAX_LINE_BYTES,
    TRANSCRIPT_CHUNK_BYTES,
    parseTranscriptAnswer,
    readTranscript,
    readableTranscriptPath,
    transcriptChunkScript
} from "@/lib/agents/session-transcript";

const EXEC_CAP = 16 * 1024;

function transcriptFile(): string {
    const dir = join(
        mkdtempSync(join(tmpdir(), "polaris-transcript-")),
        ".claude",
        "projects",
        "-session-repo"
    );
    mkdirSync(dir, { recursive: true });
    return join(dir, "a1b2.jsonl").replace(/\\/g, "/");
}

/** Runs a script the way a session would, and fails the test if the answer
 *  would not have fit under the daemon's cap. */
const scripts: string[] = [];
async function run(script: string): Promise<string> {
    scripts.push(script);
    const output = execFileSync("sh", ["-c", script], { encoding: "utf8" });
    expect(Buffer.byteLength(output)).toBeLessThan(EXEC_CAP);
    return output;
}

describe("readTranscript", () => {
    it("reads complete lines across chunks and keeps a character split between two intact", async () => {
        const path = transcriptFile();
        // `{"a":"` is 6 bytes, so the euro sign (3 bytes) starts at 10 999 and
        // straddles the first chunk boundary at 11 000.
        const first = `{"a":"${"x".repeat(TRANSCRIPT_CHUNK_BYTES - 7)}€€"}`;
        const second = `{"b":"ñandú 日本"}`;
        writeFileSync(path, `${first}\n${second}\n`);
        const read = await readTranscript(path, 0, run);
        expect(read.kind).toBe("ok");
        if (read.kind !== "ok") return;
        expect(read.lines.map((one) => one.text)).toEqual([first, second]);
        const size = Buffer.byteLength(`${first}\n${second}\n`);
        expect(read.lines.at(-1)!.end).toBe(size);
        expect(read.next).toBe(size);
        expect(read.more).toBe(false);
    });

    it("never advances past a line that is still being written", async () => {
        const path = transcriptFile();
        writeFileSync(path, '{"n":1}\n{"n":2');
        const read = await readTranscript(path, 0, run);
        if (read.kind !== "ok") throw new Error(read.kind);
        expect(read.lines.map((one) => one.text)).toEqual(['{"n":1}']);
        expect(read.next).toBe(8);

        appendFileSync(path, "}\n");
        const again = await readTranscript(path, read.next, run);
        if (again.kind !== "ok") throw new Error(again.kind);
        expect(again.lines.map((one) => one.text)).toEqual(['{"n":2}']);
        expect(again.next).toBe(16);
    });

    it("reads nothing new from the end, and starts over at 0 when the file shrank", async () => {
        const path = transcriptFile();
        writeFileSync(path, '{"n":1}\n{"n":2}\n');
        const idle = await readTranscript(path, 16, run);
        expect(idle).toMatchObject({ kind: "ok", lines: [], next: 16, restarted: false });

        writeFileSync(path, '{"n":9}\n');
        const reset = await readTranscript(path, 16, run);
        if (reset.kind !== "ok") throw new Error(reset.kind);
        expect(reset.restarted).toBe(true);
        expect(reset.lines.map((one) => one.text)).toEqual(['{"n":9}']);
        expect(reset.next).toBe(8);
    });

    it("stops at the chunk budget and says there is more", async () => {
        const path = transcriptFile();
        const line = `{"p":"${"y".repeat(4000)}"}`;
        writeFileSync(path, `${line}\n`.repeat(10));
        const read = await readTranscript(path, 0, run, { maxChunks: 1 });
        if (read.kind !== "ok") throw new Error(read.kind);
        expect(read.lines).toHaveLength(2);
        expect(read.more).toBe(true);
        const rest = await readTranscript(path, read.next, run);
        if (rest.kind !== "ok") throw new Error(rest.kind);
        expect(rest.lines).toHaveLength(8);
        expect(rest.more).toBe(false);
    });

    it("steps over a line too long to hold, once it is finished", async () => {
        const path = transcriptFile();
        const huge = `{"big":"${"z".repeat(30_000)}"}`;
        writeFileSync(path, `{"n":1}\n${huge}`);
        // Still being written: held, not skipped, and the cursor waits before it.
        const early = await readTranscript(path, 0, run, { maxLineBytes: 12_000 });
        if (early.kind !== "ok") throw new Error(early.kind);
        expect(early).toMatchObject({ skipped: 0, next: 8 });

        appendFileSync(path, '\n{"n":3}\n');
        const read = await readTranscript(path, 0, run, { maxLineBytes: 12_000 });
        if (read.kind !== "ok") throw new Error(read.kind);
        expect(read.skipped).toBe(1);
        expect(read.lines.map((one) => one.text)).toEqual(['{"n":1}', '{"n":3}']);
        expect(read.more).toBe(false);
        expect(MAX_LINE_BYTES).toBeGreaterThan(TRANSCRIPT_CHUNK_BYTES);
    });

    it("says a missing file is missing", async () => {
        expect(await readTranscript("/nowhere/.claude/projects/x/y.jsonl", 0, run)).toEqual({
            kind: "missing"
        });
    });

    it("stops at the last line it can vouch for when an answer comes back cut", async () => {
        const path = transcriptFile();
        writeFileSync(path, `{"n":1}\n${`{"p":"${"q".repeat(20_000)}"}`}\n`);
        let calls = 0;
        const cut = async (script: string) => {
            const output = await run(script);
            calls++;
            // The second chunk loses its tail, as the daemon's cap would cut it.
            return calls === 2 ? output.slice(0, 5_000) : output;
        };
        const read = await readTranscript(path, 0, cut);
        if (read.kind !== "ok") throw new Error(read.kind);
        expect(read.lines.map((one) => one.text)).toEqual(['{"n":1}']);
        expect(read.next).toBe(8);
    });
});

describe("transcript scripts", () => {
    it("quote the path, and a chunk answer parses back to its bytes", () => {
        expect(transcriptChunkScript("/a/b'c.jsonl", 5)).toContain("f='/a/b'\\''c.jsonl'");
        const answer = parseTranscriptAnswer(
            `noise\npolaris-transcript: chunk 12\n${Buffer.from("héllo").toString("base64")}\n`
        );
        expect(answer).toEqual({ kind: "chunk", size: 12, bytes: Buffer.from("héllo") });
        expect(parseTranscriptAnswer("polaris-transcript: chunk 12\nnot base64!\n")).toBeNull();
        expect(parseTranscriptAnswer("nothing")).toBeNull();
    });

    it("only open a transcript where the agents keep one", () => {
        expect(readableTranscriptPath("/root/.claude/projects/-session-repo/9f.jsonl")).toBe(true);
        expect(readableTranscriptPath("/root/.claude/accounts/work/projects/-x/9f.jsonl")).toBe(
            true
        );
        expect(readableTranscriptPath("/home/u/.codex/sessions/2026/11/07/rollout-1.jsonl")).toBe(
            true
        );
        for (const bad of [
            null,
            "relative/.claude/projects/x/y.jsonl",
            "/root/.claude/projects/x/../../../etc/passwd.jsonl",
            "/etc/shadow",
            "/root/.claude/projects/x/y.json",
            "/root/.claude/settings.jsonl",
            "/root/.claude/projects/x/y\n.jsonl"
        ])
            expect(readableTranscriptPath(bad)).toBe(false);
    });
});
