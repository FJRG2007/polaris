/**
 * What the trash is for.
 *
 * It had one door and it only went one way: a conversation in there could be
 * deleted for ever, one at a time, and that was the whole of it. Two things were
 * missing, and they are the two things anybody uses a trash for.
 *
 * **Putting something back.** Not into the inbox - back where it was deleted
 * from. Somebody who files their mail deleted that message out of a folder, and
 * answering "put it back" with the inbox hands them a second thing to undo. The
 * folder is written down at the moment of the move, because the message row does
 * not survive it: a move deletes the row and the destination writes a new one
 * with the uid the server chose. What survives is the Message-Id header, so that
 * is what the note is keyed on.
 *
 * **Emptying it.** On the server and folder-wide, not over the few hundred
 * messages Polaris holds - a button that says "empty" and leaves nine thousand
 * older ones behind is a button that lies.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { mailActionSchema, mailEmptyFolderSchema } from "@polaris/core";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

describe("what the server will accept", () => {
    const anId = "3f2b7d3e-1c9a-4a5e-9d1f-2b8c7a6e5d4c";

    it("takes putting a conversation back as an action of its own", () => {
        const parsed = mailActionSchema.safeParse({ messageIds: [anId], action: "restore" });
        expect(parsed.success).toBe(true);
    });

    it("empties the trash or the spam folder, and nothing else", () => {
        expect(mailEmptyFolderSchema.safeParse({ role: "trash" }).success).toBe(true);
        expect(mailEmptyFolderSchema.safeParse({ role: "junk" }).success).toBe(true);
        expect(mailEmptyFolderSchema.safeParse({ role: "inbox" }).success).toBe(false);
        expect(mailEmptyFolderSchema.safeParse({ role: "archive" }).success).toBe(false);
    });

    it("empties the mailboxes it is given, and says so when given none", () => {
        const parsed = mailEmptyFolderSchema.parse({ role: "trash" });
        expect(parsed.accountIds).toEqual([]);
        expect(mailEmptyFolderSchema.parse({ role: "trash", accountIds: [anId] }).accountIds).toEqual([
            anId
        ]);
    });
});

describe("where a deleted message says it came from", () => {
    const schema = readFile(`${ROOT}packages/db/prisma/schema.prisma`, "utf8");

    it("is kept against the header id, which is what survives the move", async () => {
        const source = await schema;
        const model = source.slice(source.indexOf("model MailTrashOrigin {"));
        const body = model.slice(0, model.indexOf("\n}"));
        expect(body).toContain("messageId String");
        expect(body).toContain("@@unique([accountId, messageId])");
    });

    it("goes when the folder it names goes, so a restore falls back", async () => {
        const source = await schema;
        const model = source.slice(source.indexOf("model MailTrashOrigin {"));
        const body = model.slice(0, model.indexOf("\n}"));
        expect(body).toContain(
            "MailFolder  @relation(fields: [folderId], references: [id], onDelete: Cascade)"
        );
    });

    it("is written when the move succeeded, not when it was asked for", async () => {
        const messages = await readFile(`${SRC}lib/mailbox/messages.ts`, "utf8");
        const move = messages.slice(messages.indexOf("const moved = await client.messageMove"));
        const body = move.slice(0, move.indexOf("return { done: rows.length"));
        expect(body.indexOf("if (!moved) return")).toBeLessThan(
            body.indexOf("rememberTrashOrigins")
        );
    });

    it("is forgotten by a message that leaves the trash any other way", async () => {
        const messages = await readFile(`${SRC}lib/mailbox/messages.ts`, "utf8");
        // Both doors out: destroyed, and moved somewhere deliberate.
        expect(messages).toContain('if (leaving === "trash") {');
        expect(messages).toContain('} else if (leaving === "trash") {');
    });
});

describe("putting one back", () => {
    const trash = readFile(`${SRC}lib/mailbox/trash.ts`, "utf8");

    it("sends it to the folder it was deleted from", async () => {
        const source = await trash;
        expect(source).toContain("const origin = cameFrom.get(message.messageId);");
        expect(source).toContain("{ id: origin.folderId, path: origin.folder.path }");
    });

    it("falls back to the inbox when there is no note of where it was", async () => {
        const source = await trash;
        expect(source).toContain('const inbox = await findFolderForRole(accountId, "inbox");');
        expect(source).toContain("{ id: inbox.id, path: inbox.path }");
    });

    it("drops the row rather than guessing the uid the destination gave it", async () => {
        const source = await trash;
        expect(source).toContain("await prisma.mailMessage.deleteMany({");
    });

    it("takes the row off the screen before the mail server answers", async () => {
        const actions = await readFile(`${SRC}app/(app)/mail/mail-actions.ts`, "utf8");
        const leaves = actions.slice(actions.indexOf("export function leavesTheView"));
        expect(leaves.slice(0, leaves.indexOf("default:"))).toContain('case "restore":');
    });
});

describe("emptying it", () => {
    const trash = readFile(`${SRC}lib/mailbox/trash.ts`, "utf8");

    it("reaches the whole folder on the server, not the page Polaris holds", async () => {
        const source = await trash;
        expect(source).toContain("await client.messageDelete({ all: true }, { uid: true });");
    });

    it("leaves the folder's own counts at nothing", async () => {
        const source = await trash;
        expect(source).toContain("data: { total: 0, unread: 0 }");
    });

    it("forgets where everything in it came from", async () => {
        const source = await trash;
        expect(source).toContain(
            'if (role === "trash") await prisma.mailTrashOrigin.deleteMany({ where: { accountId } });'
        );
    });

    it("asks first, and says that older mail goes too", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        expect(view).toContain("title={`Empty ${context.title}?`}");
        expect(view).toContain("including older ones that are not on this screen");
        expect(view).toContain('confirmLabel="Empty it"');
    });

    it("empties the screen on the press and puts it back if the server refuses", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        const dialog = view.slice(view.indexOf("title={`Empty ${context.title}?`}"));
        const body = dialog.slice(0, dialog.indexOf("/>"));
        expect(body.indexOf("patchUntilAnswered(here, { gone: true });")).toBeLessThan(
            body.indexOf("await emptyFolderAction(")
        );
        expect(body).toContain("clearPatches();");
    });

    it("empties the mailboxes on screen rather than every mailbox there is", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        expect(view).toContain("accounts.map((account) => account.id)");
    });
});

describe("where the two are offered", () => {
    it("is the trash, and the spam folder only for emptying", async () => {
        const views = await readFile(`${SRC}app/(app)/mail/views.ts`, "utf8");
        const trash = views.slice(views.indexOf("    trash: {"));
        expect(trash).toContain("restorable: true");
        expect(trash).toContain('emptyRole: "trash"');
        const junk = views.slice(views.indexOf("    junk: {"), views.indexOf("    trash: {"));
        expect(junk).toContain("restorable: false");
        expect(junk).toContain('emptyRole: "junk"');
    });

    it("is offered on a mailbox's own folder too, not only the merged screen", async () => {
        const page = await readFile(`${SRC}app/(app)/mail/f/[folderId]/page.tsx`, "utf8");
        expect(page).toContain('restorable: folder.role === "trash"');
        expect(page).toContain('folder.role === "trash" || folder.role === "junk" ? folder.role : ""');
    });

    it("reaches the row, the menu and the open conversation", async () => {
        const [view, menu, thread] = await Promise.all([
            readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8"),
            readFile(`${SRC}app/(app)/mail/thread-menu.tsx`, "utf8"),
            readFile(`${SRC}app/(app)/mail/thread-view.tsx`, "utf8")
        ]);
        expect(view).toContain('onClick={() => onAct("restore", "Put back.")}');
        expect(menu).toContain('onSelect={() => onAct("restore", ids, "Put back.")}');
        expect(thread).toContain('onClick={() => act("restore")}');
    });
});
