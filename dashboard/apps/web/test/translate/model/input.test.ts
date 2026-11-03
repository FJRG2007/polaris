/**
 * The one Translate box: which path each input takes - typed text, a pasted
 * picture, a dropped or chosen file, a web address.
 */

import { describe, expect, it } from "vitest";
import {
    INPUT_ACCEPT,
    LINKED_TEXT_MAX,
    linkedRequest,
    normalizeWebsite,
    pastedFile,
    routeFile,
    websiteOf,
    websiteRequest,
    websiteUrl,
    type PastedItem
} from "@polaris-app/translate/src/model/input";

function item(kind: string, type: string, file: File | null = null): PastedItem {
    return { kind, type, getAsFile: () => file };
}

describe("routeFile", () => {
    it("sends each kind of file down its own path", () => {
        expect(routeFile({ name: "shot.png", type: "image/png" })).toBe("image");
        expect(routeFile({ name: "photo.jpg", type: "image/jpeg" })).toBe("image");
        expect(routeFile({ name: "report.pdf", type: "application/pdf" })).toBe("document");
        expect(
            routeFile({
                name: "deck.pptx",
                type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            })
        ).toBe("document");
        expect(routeFile({ name: "notes.txt", type: "text/plain" })).toBe("document");
        expect(routeFile({ name: "talk.mp3", type: "audio/mpeg" })).toBe("audio");
        expect(routeFile({ name: "clip.mp4", type: "video/mp4" })).toBe("video");
    });

    it("falls back to the name when the type is missing", () => {
        expect(routeFile({ name: "SCAN.JPEG", type: "" })).toBe("image");
        expect(routeFile({ name: "subs.srt", type: "" })).toBe("document");
        expect(routeFile({ name: "memo.m4a", type: "" })).toBe("audio");
        expect(routeFile({ name: "movie.mov", type: "" })).toBe("video");
    });

    it("refuses what no path can translate", () => {
        expect(routeFile({ name: "app.exe", type: "application/octet-stream" })).toBeNull();
        expect(routeFile({ name: "vector.svg", type: "image/svg+xml" })).toBeNull();
        expect(routeFile({ name: "archive.zip", type: "application/zip" })).toBeNull();
    });

    it("names every path in the chooser's accept", () => {
        for (const part of ["image/png", ".docx", ".pdf", "audio/*", "video/*"]) {
            expect(INPUT_ACCEPT.split(",")).toContain(part);
        }
    });
});

describe("pastedFile", () => {
    const picture = new File([new Uint8Array([1])], "image.png", { type: "image/png" });
    const doc = new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" });

    it("is nothing for pasted text, so the text box takes it", () => {
        expect(pastedFile([item("string", "text/plain"), item("string", "text/html")])).toBeNull();
        expect(pastedFile(null)).toBeNull();
        expect(pastedFile([])).toBeNull();
    });

    it("takes a copied picture, even when its HTML came along", () => {
        expect(pastedFile([item("string", "text/html"), item("file", "image/png", picture)])).toBe(
            picture
        );
    });

    it("leaves text copied from an office app as text, though a picture of it came along", () => {
        expect(
            pastedFile([
                item("string", "text/plain"),
                item("string", "text/html"),
                item("string", "text/rtf"),
                item("file", "image/png", picture)
            ])
        ).toBeNull();
        expect(
            pastedFile([item("string", "text/rtf"), item("file", "image/png", picture)])
        ).toBeNull();
    });

    it("prefers the picture over another copied file", () => {
        expect(
            pastedFile([item("file", "application/pdf", doc), item("file", "image/png", picture)])
        ).toBe(picture);
    });

    it("takes a pasted document, and skips a file it cannot translate", () => {
        expect(pastedFile([item("file", "application/pdf", doc)])).toBe(doc);
        const binary = new File([new Uint8Array([1])], "x.bin", { type: "application/x-bin" });
        expect(pastedFile([item("file", "application/x-bin", binary)])).toBeNull();
        expect(pastedFile([item("file", "image/png", null)])).toBeNull();
    });
});

describe("websiteUrl", () => {
    it("normalizes: trimmed, https added, fragment dropped, host lowercased", () => {
        expect(websiteUrl.parse("  Example.COM/Page#top ")).toBe("https://example.com/Page");
        expect(websiteUrl.parse("http://example.com")).toBe("http://example.com/");
        expect(normalizeWebsite("")).toBe("");
    });

    it("takes http and https only", () => {
        for (const bad of [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "ftp://example.com/a",
            "data:text/html,hi",
            "https://user:pass@example.com/",
            "https://localhost/",
            "not a url",
            ""
        ]) {
            expect(websiteUrl.safeParse(bad).success, bad).toBe(false);
        }
        expect(websiteUrl.safeParse(`https://example.com/${"a".repeat(2100)}`).success).toBe(false);
    });

    it("is a strict request body", () => {
        expect(websiteRequest.safeParse({ url: "example.com" }).success).toBe(true);
        expect(websiteRequest.safeParse({ url: "example.com", extra: 1 }).success).toBe(false);
        expect(websiteRequest.safeParse({}).success).toBe(false);
    });
});

describe("websiteOf", () => {
    it("offers a website only when the whole text is one address", () => {
        expect(websiteOf("example.com")).toBe("https://example.com/");
        expect(websiteOf(" https://news.example.org/a?b=1 ")).toBe(
            "https://news.example.org/a?b=1"
        );
        expect(websiteOf("read example.com today")).toBeNull();
        expect(websiteOf("hello")).toBeNull();
        expect(websiteOf("e.g.")).toBeNull();
        expect(websiteOf("javascript:alert(1)")).toBeNull();
        expect(websiteOf("")).toBeNull();
    });
});

describe("linkedRequest", () => {
    it("fills the box and the language from a link", () => {
        expect(linkedRequest("?text=%20Hola%20mundo%20&to=en")).toEqual({ text: "Hola mundo", to: "en" });
    });

    it("leaves out what is not valid and keeps the rest", () => {
        expect(linkedRequest("?text=Hi&to=xx")).toEqual({ text: "Hi" });
        expect(linkedRequest("?to=de")).toEqual({ to: "de" });
        expect(linkedRequest("?text=%20%20")).toEqual({});
        expect(linkedRequest("")).toEqual({});
    });

    it("caps a long text", () => {
        const answer = linkedRequest(`?text=${"a".repeat(LINKED_TEXT_MAX + 50)}`);
        expect(answer.text).toHaveLength(LINKED_TEXT_MAX);
    });
});
