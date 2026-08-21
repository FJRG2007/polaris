/**
 * Which files a conversation offers to open, and which it still only saves.
 *
 * The rule has to be right in both directions and neither is obvious from
 * reading it. Offer too little and the feature is missing on exactly the files
 * it was built for - a report with no extension, a `.csv` somebody exported.
 * Offer too much and an archive opens as a wall of replacement characters,
 * which is worse than the download it replaced, and a picture gets a second
 * viewer over the one the conversation already drew.
 *
 * The type is the sender's, so it is never trusted on its own: a name that says
 * what a file is wins, and the type only decides the cases where the name says
 * nothing.
 */

import { describe, expect, it } from "vitest";
import { previewableAs } from "@/app/(app)/chat/attachment-viewer";

describe("what a conversation offers to open", () => {
    it("opens the formats somebody sends to be read", () => {
        expect(previewableAs("invoice.pdf", "application/pdf")).toBe("pdf");
        expect(previewableAs("Q3 numbers.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("sheet");
        expect(previewableAs("contract.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("doc");
        expect(previewableAs("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("slides");
        expect(previewableAs("NOTES.md", "text/markdown")).toBe("markdown");
        expect(previewableAs("export.csv", "text/csv")).toBe("sheet");
        expect(previewableAs("deploy.sh", "application/octet-stream")).toBe("code");
    });

    it("leaves what the conversation already draws alone", () => {
        // A second viewer over a picture the message list has already put on
        // screen, or over a clip with a player under it, is a worse version of
        // what is already there.
        expect(previewableAs("holiday.jpg", "image/jpeg")).toBeNull();
        expect(previewableAs("clip.mp4", "video/mp4")).toBeNull();
        expect(previewableAs("note.ogg", "audio/ogg")).toBeNull();
    });

    it("refuses what has nothing to show", () => {
        expect(previewableAs("backup.zip", "application/zip")).toBeNull();
        expect(previewableAs("setup.exe", "application/octet-stream")).toBeNull();
        expect(previewableAs("photos.tar.gz", "application/gzip")).toBeNull();
    });

    it("opens the plain-text formats nothing highlights", () => {
        expect(previewableAs("notes.txt", "text/plain")).toBe("text");
        expect(previewableAs("server.log", "application/octet-stream")).toBe("text");
        expect(previewableAs("subtitles.srt", "")).toBe("text");
        // Everything else that is text is a language the highlighter knows.
        expect(previewableAs("app.ini", "")).toBe("code");
        expect(previewableAs("stack.yaml", "")).toBe("code");
    });

    it("goes on the sender's type only when the name says nothing", () => {
        // No extension at all: a README, a LICENSE, a log somebody pasted out
        // of a terminal.
        expect(previewableAs("LICENSE", "text/plain")).toBe("text");
        expect(previewableAs("changelog", "")).toBe("text");
        expect(previewableAs("config", "application/json")).toBe("text");
        // The same shape of name, claiming to be something that is not text.
        expect(previewableAs("blob", "application/octet-stream")).toBeNull();
    });

    it("does not let a type overrule a name that already said what it is", () => {
        // Browsers and phones send `application/octet-stream` for anything they
        // do not recognize, which is most of what gets attached. The name is
        // what decides.
        expect(previewableAs("report.pdf", "application/octet-stream")).toBe("pdf");
        expect(previewableAs("archive.zip", "text/plain")).toBeNull();
    });
});
