import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, open, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { readTranscriptPiece, transcriptRoots, type TranscriptDeps } from "@/main/runner/transcript";
import { TRANSCRIPT_LIMITS, transcriptAnswerSchema } from "../../../../dashboard/packages/core/src/runner-protocol";

let home: string;
let projects: string;
let file: string;

const deps: TranscriptDeps = {
    realpath: (path) => realpath(path),
    stat: async (path) => {
        const found = await stat(path).catch(() => null);
        return found ? { size: found.size, file: found.isFile() } : null;
    },
    read: async (path, offset, length) => {
        const handle = await open(path, "r");
        try {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return buffer.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    }
};

const LINES = '{"type":"user","n":1}\n{"type":"assistant","n":2}\n{"partial":';

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "runner-home-"));
    projects = join(home, ".claude", "projects");
    await mkdir(join(projects, "C--work-repo"), { recursive: true });
    file = join(projects, "C--work-repo", "9f1c.jsonl");
    await writeFile(file, LINES);
    await writeFile(join(projects, "loose.jsonl"), "{}\n");
    await writeFile(join(home, "elsewhere.jsonl"), "{}\n");
    await writeFile(join(projects, "C--work-repo", "big.jsonl"), `${"y".repeat(TRANSCRIPT_LIMITS.chunkBytes + 10)}\n`);
});

afterAll(async () => {
    await rm(home, { recursive: true, force: true });
});

const roots = () => transcriptRoots({}, home);

describe("transcriptRoots", () => {
    it("is the home's Claude projects folder, plus the one under CLAUDE_CONFIG_DIR", () => {
        expect(transcriptRoots({}, home)).toEqual([join(home, ".claude", "projects")]);
        const config = join(home, "alt-config");
        expect(transcriptRoots({ CLAUDE_CONFIG_DIR: config }, home)).toEqual([join(home, ".claude", "projects"), join(config, "projects")]);
        expect(transcriptRoots({ CLAUDE_CONFIG_DIR: "relative/dir" }, home)).toHaveLength(1);
    });
});

describe("readTranscriptPiece", () => {
    it("reads a chunk from an offset with the file's size", async () => {
        const answer = await readTranscriptPiece(true, file, { kind: "chunk", offset: 0 }, roots(), deps);
        expect(answer).toEqual({ kind: "chunk", size: LINES.length, data: Buffer.from(LINES).toString("base64") });
        expect(transcriptAnswerSchema.safeParse(answer).success).toBe(true);
        const later = await readTranscriptPiece(true, file, { kind: "chunk", offset: 22 }, roots(), deps);
        expect(later.kind === "chunk" && Buffer.from(later.data, "base64").toString()).toBe(LINES.slice(22));
        expect(await readTranscriptPiece(true, file, { kind: "chunk", offset: 10_000 }, roots(), deps)).toEqual({ kind: "chunk", size: LINES.length, data: "" });
    });

    it("caps a chunk at the protocol's chunk size", async () => {
        const answer = await readTranscriptPiece(true, join(projects, "C--work-repo", "big.jsonl"), { kind: "chunk", offset: 0 }, roots(), deps);
        expect(answer.kind === "chunk" && Buffer.from(answer.data, "base64").length).toBe(TRANSCRIPT_LIMITS.chunkBytes);
        expect(transcriptAnswerSchema.safeParse(answer).success).toBe(true);
    });

    it("measures a line, newline included, and an unfinished one as 0", async () => {
        expect(await readTranscriptPiece(true, file, { kind: "line", offset: 0 }, roots(), deps)).toEqual({ kind: "line", size: LINES.length, length: 22 });
        expect(await readTranscriptPiece(true, file, { kind: "line", offset: 49 }, roots(), deps)).toEqual({ kind: "line", size: LINES.length, length: 0 });
        const big = await readTranscriptPiece(true, join(projects, "C--work-repo", "big.jsonl"), { kind: "line", offset: 0 }, roots(), deps);
        expect(big).toMatchObject({ length: TRANSCRIPT_LIMITS.chunkBytes + 11 });
    });

    it("answers missing for a session it does not hold, a path outside the projects folders, or no file", async () => {
        expect(await readTranscriptPiece(false, file, { kind: "chunk", offset: 0 }, roots(), deps)).toEqual({ kind: "missing" });
        for (const path of [
            join(home, "elsewhere.jsonl"),
            join(projects, "loose.jsonl"),
            join(projects, "C--work-repo", "..", "..", "..", "elsewhere.jsonl"),
            join(projects, "C--work-repo", "nope.jsonl"),
            join(projects, "C--work-repo"),
            "relative/9f1c.jsonl",
            file.replace(/\.jsonl$/, ".txt"),
            `${file}\n`
        ])
            expect(await readTranscriptPiece(true, path, { kind: "chunk", offset: 0 }, roots(), deps)).toEqual({ kind: "missing" });
    });

    it("refuses a link inside the projects folder that points outside it", async () => {
        const link = join(projects, "C--work-repo", "link.jsonl");
        try {
            await symlink(join(home, "elsewhere.jsonl"), link, "file");
        } catch {
            return; // Symbolic links need a privilege on Windows.
        }
        expect(await readTranscriptPiece(true, link, { kind: "chunk", offset: 0 }, roots(), deps)).toEqual({ kind: "missing" });
    });
});
