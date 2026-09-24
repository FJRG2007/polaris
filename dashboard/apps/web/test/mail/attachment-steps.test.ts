/**
 * Moving between a message's attachments in the viewer.
 *
 * The run is exactly the files the list under the message offers to open, in
 * its order; a picture drawn in the body is not a stop; and the ends are ends,
 * so "4 of 4" is the last one rather than a door back to the first.
 */

import { describe, expect, it } from "vitest";
import { isViewable } from "@/app/(app)/drive/viewer/kind";
import {
    conversationFiles,
    openableAttachments,
    positionOf,
    stepFrom
} from "@/app/(app)/mail/attachment-steps";

const files = [
    { id: "a", name: "invoice.pdf", inline: false },
    { id: "b", name: "logo.png", inline: true },
    { id: "c", name: "notes.txt", inline: false },
    { id: "d", name: "scan.jpg", inline: false },
    { id: "e", name: "budget.xlsx", inline: false }
];

describe("which attachments the arrows step through", () => {
    it("is the ones the message's list offers to open, in its order", () => {
        const offered = files.filter((file) => !file.inline && isViewable(file.name));
        expect(openableAttachments(files)).toEqual(offered);
        expect(openableAttachments(files).map((file) => file.id)).toEqual(["a", "c", "d", "e"]);
    });

    it("counts only those, so the indicator says where the reader is among them", () => {
        const run = openableAttachments(files);
        expect(positionOf(run, "d")).toBe(2);
        expect(run).toHaveLength(4);
    });

    it("does not know a picture drawn in the body", () => {
        const run = openableAttachments(files);
        expect(positionOf(run, "b")).toBe(-1);
        expect(stepFrom(run, "b", 1)).toBeNull();
    });
});

describe("a step", () => {
    const run = openableAttachments(files);

    it("goes to the next and the previous file", () => {
        expect(stepFrom(run, "a", 1)?.id).toBe("c");
        expect(stepFrom(run, "e", -1)?.id).toBe("d");
    });

    it("stops at either end rather than wrapping", () => {
        expect(stepFrom(run, "a", -1)).toBeNull();
        expect(stepFrom(run, "e", 1)).toBeNull();
    });
});

describe("the viewer the steps are drawn in", () => {
    it("is the one Drive and Chat open files in, given the steps", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = fileURLToPath(new URL("../../src/", import.meta.url));
        const thread = await readFile(`${src}app/(app)/mail/thread-view.tsx`, "utf8");
        expect(thread).toContain("steps={");
        expect(thread).toContain("stepFrom(openable, viewing.path, by)");
        const viewer = await readFile(`${src}app/(app)/drive/file-viewer.tsx`, "utf8");
        // Left and Right, and the count, only when there is more than one file.
        expect(viewer).toContain('event.key === "ArrowLeft" && canBack');
        expect(viewer).toContain('event.key === "ArrowRight" && canForward');
        expect(viewer).toContain("{stepping.index + 1} of {stepping.count}");
        expect(viewer).toContain("steps && steps.count > 1 ? steps : null");
    });
});

describe("the files of a whole conversation", () => {
    const message = (
        id: string,
        sentAt: string,
        from: string,
        attachments: { id: string; name: string; size: number; inline?: boolean }[]
    ) => ({
        id,
        sentAt,
        from: [{ name: from, address: `${from.toLowerCase()}@example.com` }],
        attachments: attachments.map((file) => ({ inline: false, ...file }))
    });

    it("lists every file in the thread, newest first", () => {
        const files = conversationFiles([
            message("m1", "2026-09-01T10:00:00Z", "Ana", [
                { id: "a", name: "contract.pdf", size: 10 }
            ]),
            message("m2", "2026-09-02T10:00:00Z", "Me", []),
            message("m3", "2026-09-03T10:00:00Z", "Me", [
                { id: "b", name: "invoice.pdf", size: 20 }
            ])
        ]);
        expect(files.map((file) => [file.id, file.from, file.messageId])).toEqual([
            ["b", "Me", "m3"],
            ["a", "Ana", "m1"]
        ]);
    });

    it("counts the copy in Sent and the one quoted back as one file", () => {
        const files = conversationFiles([
            message("sent", "2026-09-23T16:53:00Z", "Me", [
                { id: "a", name: "Adenda.pdf", size: 900 }
            ]),
            message("back", "2026-09-24T05:36:00Z", "Ana", [
                { id: "b", name: "adenda.pdf", size: 900 }
            ])
        ]);
        expect(files.map((file) => file.id)).toEqual(["b"]);
    });

    it("keeps two different files that share a name", () => {
        const files = conversationFiles([
            message("m1", "2026-09-01T10:00:00Z", "Ana", [{ id: "a", name: "scan.pdf", size: 10 }]),
            message("m2", "2026-09-02T10:00:00Z", "Ana", [{ id: "b", name: "scan.pdf", size: 11 }])
        ]);
        expect(files).toHaveLength(2);
    });

    it("leaves out the pictures a message draws itself", () => {
        const files = conversationFiles([
            message("m1", "2026-09-01T10:00:00Z", "Ana", [
                { id: "logo", name: "firma.jpg", size: 5, inline: true },
                { id: "a", name: "contract.pdf", size: 10 }
            ])
        ]);
        expect(files.map((file) => file.id)).toEqual(["a"]);
    });
});
