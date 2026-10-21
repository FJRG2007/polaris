/**
 * Items dragged onto Polar from the apps.
 *
 * The payload is read off a drop any page could have started, so what is
 * pinned is that only our own shapes get through - and that the apps that drag
 * things (Mail, Drive, Chat) actually put the payload on their drags.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    carriesItems,
    itemLabel,
    readDraggedItems,
    writeDraggedItems,
    DRAG_MOST,
    POLARIS_ITEM_TYPE
} from "@/lib/polar/dropped-items";

const ID = "0192f0a4-1c2b-7d3e-8f40-1234567890ab";

function transfer(data: Record<string, string>, effectAllowed = "move") {
    return {
        effectAllowed,
        getData: (type: string) => data[type] ?? "",
        setData: (type: string, value: string) => {
            data[type] = value;
        }
    } as unknown as DataTransfer;
}

describe("reading a drop", () => {
    it("takes our own items", () => {
        const items = [
            { kind: "mail-message", id: ID, title: "Invoice" },
            { kind: "drive-file", connectionId: "nas-1", path: "docs/a.pdf" },
            { kind: "chat-attachment", id: ID }
        ];
        expect(readDraggedItems(transfer({ [POLARIS_ITEM_TYPE]: JSON.stringify(items) }))).toEqual(
            items
        );
    });

    it.each([
        ["not JSON", "{"],
        ["nothing", ""],
        ["an object, not a list", JSON.stringify({ kind: "mail-message", id: ID })],
        ["an empty list", "[]"],
        ["a kind nobody defined", JSON.stringify([{ kind: "vault-secret", id: ID }])],
        ["an id that is not a row id", JSON.stringify([{ kind: "mail-message", id: "../../etc" }])],
        ["a Drive file without its storage", JSON.stringify([{ kind: "drive-file", path: "a" }])],
        ["more than a drag carries", JSON.stringify(Array(8).fill({ kind: "chat-attachment", id: ID }))]
    ])("refuses %s", (_, raw) => {
        expect(readDraggedItems(transfer({ [POLARIS_ITEM_TYPE]: raw }))).toBeNull();
    });

    it("says whether a drag carries items, before the drop", () => {
        expect(carriesItems(["text/plain", POLARIS_ITEM_TYPE])).toBe(true);
        expect(carriesItems(["Files"])).toBe(false);
    });
});

describe("writing a drag", () => {
    it("adds the items and lets them be copied beside the source's own move", () => {
        const data: Record<string, string> = {};
        const drag = transfer(data, "move");
        writeDraggedItems(drag, [{ kind: "mail-message", id: ID }]);
        expect(JSON.parse(data[POLARIS_ITEM_TYPE]!)).toEqual([{ kind: "mail-message", id: ID }]);
        expect(drag.effectAllowed).toBe("copyMove");
    });

    it("carries one past what a message holds, so the composer can say some were left out", () => {
        const data: Record<string, string> = {};
        const many = Array.from({ length: 20 }, () => ({ kind: "chat-attachment" as const, id: ID }));
        writeDraggedItems(transfer(data), many);
        expect(JSON.parse(data[POLARIS_ITEM_TYPE]!)).toHaveLength(DRAG_MOST);
        expect(readDraggedItems(transfer(data))).toHaveLength(DRAG_MOST);
    });

    it("writes nothing for nothing", () => {
        const data: Record<string, string> = {};
        writeDraggedItems(transfer(data), []);
        expect(data[POLARIS_ITEM_TYPE]).toBeUndefined();
    });

    it("names a Drive file by its file name until the server answers", () => {
        expect(itemLabel({ kind: "drive-file", connectionId: "c", path: "a/b/report.pdf" })).toBe(
            "report.pdf"
        );
    });
});

describe("the apps that drag things", () => {
    const source = (path: string) => readFileSync(resolve(__dirname, "../../src", path), "utf8");

    it.each([
        ["Mail rows", "app/(app)/mail/mail-view.tsx", '"mail-message"'],
        ["Drive files", "app/(app)/drive/files-view.tsx", '"drive-file"'],
        ["Chat pictures", "app/(app)/chat/message-list.tsx", '"chat-attachment"']
    ])("%s put the payload on their drag", (_, path, kind) => {
        const text = source(path);
        expect(text).toMatch(/droppedItems\.writeDraggedItems\(\s*event\.dataTransfer/);
        expect(text).toContain(kind);
    });
});
