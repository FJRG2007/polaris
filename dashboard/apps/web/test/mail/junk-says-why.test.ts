/**
 * A message that was filed away, and whether its reader can see why.
 *
 * One line was enough while the filter only ever warned: somebody could look at
 * the message under the warning and disagree. A message it MOVED is different -
 * the reader is deciding whether the filter was right about mail they have not
 * got, and the heaviest accusation on its own is not enough to decide on.
 *
 * Read from the source rather than rendered, the way the rest of this folder
 * pins the arrival path: what is being checked is that the reasons survive the
 * whole way from the judgement to the screen, and every one of those steps is a
 * place they have silently been dropped before.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("../../src/", import.meta.url));

describe("why a message is in Junk", () => {
    it("is written down when the message is judged", async () => {
        const spam = await readFile(`${WEB}lib/mailbox/spam.ts`, "utf8");
        expect(spam).toContain("spamReasons: [...judged.reasons]");
    });

    it("is taken back when somebody says the filter was wrong", async () => {
        // Pressing Not junk has to leave the message saying nothing about
        // itself, not a list of accusations somebody has already overruled.
        const spam = await readFile(`${WEB}lib/mailbox/spam.ts`, "utf8");
        expect(spam).toContain('{ spamScore: 0, spamReason: "", spamReasons: [] }');
    });

    it("is read back with the conversation", async () => {
        const views = await readFile(`${WEB}lib/mailbox/views.ts`, "utf8");
        expect(views).toContain("spamReasons: true");
        expect(views).toContain("spamReasons: message.spamReasons");
    });

    it("is only spelled out for a message that was actually filed", async () => {
        // A warning on a message still in the inbox gets the one line. The list
        // belongs to the message somebody has to go and look for.
        const view = await readFile(`${WEB}app/(app)/mail/thread-view.tsx`, "utf8");
        expect(view).toContain('message.folderRole === "junk" &&');
        expect(view).toContain("message.spamReasons.length > 1");
    });
});
