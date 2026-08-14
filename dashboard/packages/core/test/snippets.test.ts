/**
 * What a snippet and a text drop point will accept.
 *
 * These schemas are the only thing standing between a public form and the
 * database, so the cases here are the ones where saying yes would be a mistake:
 * a paste large enough to be a payload rather than a snippet, a "sealed" snippet
 * that still claims to be JavaScript (a claim about bytes the server cannot
 * read), a link shared with nobody, and a file name carrying a path.
 */

import { describe, expect, it } from "vitest";
import {
    createSnippetSchema,
    createTextRequestSchema,
    MAX_SNIPPET_FILES,
    MAX_SNIPPET_TOTAL_CHARS,
    shareSnippetSchema,
    snippetFileName,
    submitTextSchema
} from "../src/schemas/snippet.js";

const file = (over: Partial<{ name: string; language: string; body: string }> = {}) => ({
    name: "app.ts",
    language: "typescript",
    body: "export const answer = 42;",
    ...over
});

describe("snippetFileName", () => {
    it("keeps the name and drops the path around it", () => {
        expect(snippetFileName.parse("src/app/page.tsx")).toBe("src app page.tsx");
        expect(snippetFileName.parse("  .env.production  ")).toBe(".env.production");
    });

    it("refuses a name that is only separators", () => {
        expect(snippetFileName.safeParse("///").success).toBe(false);
        expect(snippetFileName.safeParse("   ").success).toBe(false);
    });
});

describe("createSnippetSchema", () => {
    it("takes a snippet with one file and defaults it to private", () => {
        const parsed = createSnippetSchema.parse({ files: [file()] });
        expect(parsed.visibility).toBe("private");
        expect(parsed.burnAfterRead).toBe(false);
        expect(parsed.allowedCidrs).toEqual([]);
    });

    it("refuses a snippet with no files at all", () => {
        expect(createSnippetSchema.safeParse({ files: [] }).success).toBe(false);
    });

    it("refuses more files than a paste should hold", () => {
        const files = Array.from({ length: MAX_SNIPPET_FILES + 1 }, (_, index) =>
            file({ name: `file-${index}.txt` })
        );
        expect(createSnippetSchema.safeParse({ files }).success).toBe(false);
    });

    it("adds the files up rather than checking them one at a time", () => {
        // Each half the ceiling: both pass alone, and together they are over it.
        const half = "x".repeat(Math.ceil(MAX_SNIPPET_TOTAL_CHARS / 2) + 1);
        const result = createSnippetSchema.safeParse({
            files: [file({ body: half }), file({ name: "b.txt", body: half })]
        });
        expect(result.success).toBe(false);
    });

    it("refuses an invite snippet nobody was invited to", () => {
        const result = createSnippetSchema.safeParse({
            visibility: "invite",
            inviteUsers: [],
            files: [file()]
        });
        expect(result.success).toBe(false);
    });

    it("normalizes who was invited", () => {
        const parsed = createSnippetSchema.parse({
            visibility: "invite",
            inviteUsers: ["@Ana", "ana", " BEN@example.com "],
            files: [file()]
        });
        expect(parsed.inviteUsers).toEqual(["ana", "ben@example.com"]);
    });

    it("refuses a sealed snippet that claims a language", () => {
        // The server holds ciphertext for a sealed snippet. Labelling it
        // "typescript" would be a statement about bytes nobody there can read.
        const result = createSnippetSchema.safeParse({
            visibility: "link",
            clientSealed: true,
            files: [file()]
        });
        expect(result.success).toBe(false);
        expect(
            createSnippetSchema.safeParse({
                visibility: "link",
                clientSealed: true,
                files: [file({ language: "" })]
            }).success
        ).toBe(true);
    });

    it("refuses an address rule that is not an address", () => {
        expect(
            createSnippetSchema.safeParse({ files: [file()], allowedCidrs: ["not-an-ip"] }).success
        ).toBe(false);
        expect(
            createSnippetSchema.safeParse({ files: [file()], allowedCidrs: ["10.0.0.0/8"] }).success
        ).toBe(true);
    });
});

describe("shareSnippetSchema", () => {
    it("tells an untouched limit from one being cleared", () => {
        const parsed = shareSnippetSchema.parse({ visibility: "link", maxViews: null });
        expect(parsed.maxViews).toBeNull();
        expect(parsed.expiresAt).toBeUndefined();
    });
});

describe("createTextRequestSchema", () => {
    it("defaults to open to anyone, with a ceiling on what they can send", () => {
        const parsed = createTextRequestSchema.parse({});
        expect(parsed.requireLogin).toBe(false);
        expect(parsed.allowSealed).toBe(false);
        expect(parsed.maxLength).toBeGreaterThan(0);
    });

    it("normalizes the people it is limited to", () => {
        const parsed = createTextRequestSchema.parse({ allowedUsers: ["@Ana", "ANA", ""] });
        expect(parsed.allowedUsers).toEqual(["ana"]);
    });
});

describe("submitTextSchema", () => {
    it("refuses an empty submission", () => {
        expect(submitTextSchema.safeParse({ name: "x.txt", body: "" }).success).toBe(false);
    });

    it("defaults to not sealed", () => {
        expect(submitTextSchema.parse({ name: "x.txt", body: "hello" }).sealed).toBe(false);
    });
});
