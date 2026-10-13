/**
 * A delete the mail server refused is said, not answered as done.
 *
 * imapflow answers a refused MOVE or EXPUNGE with `false` and writes the
 * server's reason to its logger. Polaris had the logger off and counted the
 * refusal as "nothing to do", so the button reported success, the row left the
 * screen, and the next list put the message back - deleted again, back again.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { describeImapEntry } from "@/lib/mailbox/imap";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("a refused move or delete", () => {
    it("is marked refused where the server said no", async () => {
        const messages = await readFile(`${SRC}lib/mailbox/messages.ts`, "utf8");
        expect(messages).toContain('if (!removed) return { done: 0, movedTo: "", unseen: 0, refused: true };');
        expect(messages).toContain('if (!moved) return { done: 0, movedTo: "", unseen: 0, refused: true };');
        expect(messages).toContain("if (options.strict && refused.length > 0) {");
    });

    it("reaches the person who pressed the button as an error", async () => {
        const actions = await readFile(`${SRC}app/(app)/mail/actions.ts`, "utf8");
        expect(actions).toContain("{ scope: parsed.data.scope, strict: true }");
    });

    it("leaves the server's reason in the log", () => {
        expect(
            describeImapEntry({
                msg: "Command failed",
                err: { command: "UID MOVE", message: "Command failed", responseText: "[OVERQUOTA] Quota exceeded" },
                cid: "abc"
            })
        ).toBe("Command failed - UID MOVE - Command failed - [OVERQUOTA] Quota exceeded");
        expect(describeImapEntry(undefined)).toBe("undefined");
    });
});
