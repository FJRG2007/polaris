import { describe, expect, it } from "vitest";
import { attachmentCommands } from "@/lib/agents/session-attachments";

/** The host daemon's ceiling on one argument (`deploy_exec_run`). */
const HOSTD_ARG_MAX = 16384;

describe("attachmentCommands", () => {
    it("keeps every command under the daemon's argument ceiling, for a 2 MiB conversation file", () => {
        const bytes = new Uint8Array(2 * 1024 * 1024).map((_, index) => index % 251);
        const workdir = "/home/node/work/acme-some-quite-long-repository-name-for-the-checkout";
        const commands = attachmentCommands(workdir, [{ path: ".polaris/attachments/conversation.md", bytes }]);
        for (const command of commands) expect(Buffer.byteLength(["sh", "-c", command][2]!)).toBeLessThan(HOSTD_ARG_MAX);
        const written = commands
            .map((command) => /printf %s '([^']*)'/.exec(command)?.[1] ?? "")
            .map((b64) => Buffer.from(b64, "base64"));
        expect(Buffer.concat(written).equals(Buffer.from(bytes))).toBe(true);
    });
});
