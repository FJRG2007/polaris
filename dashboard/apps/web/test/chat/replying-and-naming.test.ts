/**
 * Two things about a conversation that were nearly right.
 *
 * **Pressing Reply sometimes left the caret where it was.** The composer asked
 * for the caret when the message being answered changed, which is not the same
 * question as "was Reply pressed": pressing it twice on one message changed
 * nothing to depend on, so the second press did nothing at all. And the editor
 * asked the browser once, on a zero timer, while a menu that was still
 * unmounting handed focus back to the control that opened it - a race it won on
 * a fast machine and lost on a slow one, which is what "not always" was.
 *
 * **A nickname left nothing on screen saying whose account it was.** A nickname
 * replaces the name wherever Polaris shows a reader their own people, so the top
 * of a conversation said "Dad" and nowhere said who that is. Every chat client
 * with nicknames draws both there.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("pressing reply", () => {
    it("is counted, so pressing it twice on one message still asks", async () => {
        const view = await readFile(`${SRC}app/(app)/chat/channel-view.tsx`, "utf8");
        expect(view).toContain("setReplyAt((current) => current + 1);");
        expect(view).toContain("onReply={reply}");
        expect(view).toContain("replyAt={replyAt}");
    });

    it("is what the composer watches, not only which message it is", async () => {
        const composer = await readFile(`${SRC}app/(app)/chat/composer.tsx`, "utf8");
        expect(composer).toContain("}, [editingId, replyingToId, replyAt]);");
    });

    it("survives a menu handing focus back as it closes", async () => {
        const editor = await readFile(`${SRC}components/rich-text/rich-text-editor.tsx`, "utf8");
        // The window has to outlast the menu's exit animation rather than race
        // it. A fifth of a second did not: Reply from a right-click could spend
        // every try inside the context menu's focus trap, be undone by it, and
        // leave nothing to try again - while Reply from the hover row, which
        // opens no menu, worked every time.
        expect(editor).toContain("const attempts = [0, 60, 140, 260, 400];");
        // And stops the moment the caret is where it was asked for, so the extra
        // tries cost nothing in the ordinary case.
        expect(editor).toContain("if (editor.isDestroyed || editor.isFocused) return;");
    });

    it("leaves the caret alone when the reader has put it somewhere else", async () => {
        const editor = await readFile(`${SRC}components/rich-text/rich-text-editor.tsx`, "utf8");
        const asks = editor.slice(editor.indexOf("function focusIsElsewhere"));
        const body = asks.slice(0, asks.indexOf("\n}"));
        // A field or another box is somebody writing; a button or the body is a
        // menu having let go.
        expect(body).toContain('if (tag === "input" || tag === "textarea") return true;');
        expect(body).toContain("on.isContentEditable");
        expect(body).toContain("if (!on || on === document.body) return false;");
    });
});

describe("somebody you have given a name", () => {
    it("is drawn with what they are actually called beside it", async () => {
        const header = await readFile(`${SRC}app/(app)/chat/channel-header.tsx`, "utf8");
        expect(header).toContain("<PersonRealName");
        expect(header).toContain("id={channel.others[0].id}");
    });

    it("draws nothing for anybody who has not been given one", async () => {
        const names = await readFile(`${SRC}components/person-name.tsx`, "utf8");
        const real = names.slice(names.indexOf("export function PersonRealName"));
        expect(real).toContain("if (!called || !real || called === real) return null;");
    });

    it("follows a rename, like every other name on the screen", async () => {
        const names = await readFile(`${SRC}components/person-name.tsx`, "utf8");
        const real = names.slice(names.indexOf("export function PersonRealName"));
        // The live name over the one this screen was rendered with.
        expect(real).toContain("const live = useProfileName(id);");
        expect(real).toContain("const real = live ?? name;");
    });
});
