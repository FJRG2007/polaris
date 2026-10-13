/**
 * A draft that was sent leaves the drafts screen without a reload.
 *
 * The queue deletes the draft on the server once the message goes and says so
 * on the live channel as a "sending" frame. The drafts screen was rendered once
 * from the page and never listened, so a sent message sat there as a draft until
 * somebody reloaded. It now asks for its own list again on that frame - one
 * query, not the router re-rendering the signed-in frame.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("the drafts screen", () => {
    it("asks for its list again when the queue says a message moved", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/drafts/drafts-view.tsx`, "utf8");
        expect(view).toContain("useMailStream((frame) => {");
        expect(view).toContain('if (frame.kind !== "sending") return;');
        expect(view).toContain("void listDraftsAction()");
        expect(view).not.toContain("router.refresh()");
    });

    it("gets that list from one query on the server", async () => {
        const actions = await readFile(`${SRC}app/(app)/mail/actions.ts`, "utf8");
        expect(actions).toContain("export async function listDraftsAction() {");
        expect(actions).toContain("return await compose.listDrafts(await actorId());");
    });

    it("is told whenever a queued message leaves", async () => {
        const compose = await readFile(`${SRC}lib/mailbox/compose.ts`, "utf8");
        expect(compose).toContain('publishMail({ accountId: account.id, kind: "sending", actorId: account.userId });');
    });
});
