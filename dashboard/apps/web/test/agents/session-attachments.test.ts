import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** Whether a POSIX shell is on hand (Git Bash on Windows counts). */
function hasSh(): boolean {
    try {
        execFileSync("sh", ["-c", "command -v base64"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/polar/attachments", () => ({ readPolarAttachment: vi.fn() }));

import * as core from "@polaris/core";
import {
    ATTACHMENTS_DIR,
    attachmentCommands,
    attachmentFileName,
    attachmentPaths,
    withAttachmentNote
} from "@/lib/agents/session-attachments";

describe("session attachments", () => {
    it("names files safely and in order", () => {
        expect(attachmentFileName(0, "My Screenshot (1).png")).toBe("1-My-Screenshot-1-.png");
        expect(attachmentFileName(1, "../../etc/passwd")).toBe("2-etc-passwd");
        expect(attachmentFileName(2, "'; rm -rf /")).toBe("3-rm--rf-");
        expect(attachmentFileName(3, "")).toBe("4-file");
        expect(attachmentPaths(["a.txt", "a.txt"])).toEqual([
            `${ATTACHMENTS_DIR}/1-a.txt`,
            `${ATTACHMENTS_DIR}/2-a.txt`
        ]);
    });

    it("names the files in the prompt, and leaves a prompt without files alone", () => {
        expect(withAttachmentNote("fix it", [])).toBe("fix it");
        const note = withAttachmentNote("fix it", [".polaris/attachments/1-a.png"]);
        expect(note).toContain("fix it");
        expect(note).toContain("- .polaris/attachments/1-a.png");
    });

    it("builds commands with no control character, each under one argument's limit", () => {
        const bytes = new Uint8Array(200 * 1024).map((_, i) => i % 251);
        const commands = attachmentCommands("/session/repo", [{ path: `${ATTACHMENTS_DIR}/1-x.bin`, bytes }]);
        for (const command of commands) {
            expect(core.hasControlCharacter(command)).toBe(false);
            expect(command.length).toBeLessThan(100 * 1024);
        }
    });

    it.skipIf(!hasSh())("writes the bytes back exactly, git-ignored", () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-attach-")).replace(/\\/g, "/");
        const bytes = new Uint8Array(150 * 1024 + 7).map((_, i) => (i * 7) % 256);
        const empty = new Uint8Array(0);
        const commands = attachmentCommands(dir, [
            { path: `${ATTACHMENTS_DIR}/1-x.bin`, bytes },
            { path: `${ATTACHMENTS_DIR}/2-empty.txt`, bytes: empty }
        ]);
        const script = join(dir, "..", `${dir.split(/[\/]/).pop()}.sh`);
        writeFileSync(script, `set -e\n${commands.join("\n")}\n`);
        execFileSync("sh", [script]);
        expect(Buffer.compare(readFileSync(join(dir, ATTACHMENTS_DIR, "1-x.bin")), Buffer.from(bytes))).toBe(0);
        expect(existsSync(join(dir, ATTACHMENTS_DIR, "2-empty.txt"))).toBe(true);
        expect(readFileSync(join(dir, ".polaris/.gitignore"), "utf8")).toBe("*\n");
    });
});
