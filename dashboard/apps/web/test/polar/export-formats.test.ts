import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));

import * as exports from "@/lib/polar/export";

const NAMES = {
    user: "You",
    assistant: "Polar",
    untitled: "Conversation",
    attachment: "attachment",
    file: (name: string) => `File: ${name}`,
    used: (name: string) => `Used ${name}`,
    truncated: "Cut",
    compacted: () => "Compacted"
};

function thread(text: string): exports.ExportThread {
    return {
        id: "11111111-1111-4111-8111-111111111111",
        title: "A <b>chat</b>",
        createdAt: "2026-11-02T10:00:00.000Z",
        updatedAt: "2026-11-02T10:00:00.000Z",
        truncated: false,
        messages: [
            {
                id: "m1",
                parentId: null,
                role: "assistant",
                parts: [{ type: "text", text }],
                metadata: null,
                createdAt: "2026-11-02T10:00:00.000Z"
            }
        ]
    };
}

describe("the HTML export", () => {
    it("shows a model's markup as text and can run nothing", () => {
        const html = exports.threadHtml(thread("<script>alert(1)</script>

**bold**"), NAMES);
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
        expect(html).toContain("<strong>bold</strong>");
        expect(html).toContain("default-src 'none'");
        expect(html).toContain("A &lt;b&gt;chat&lt;/b&gt;");
    });

    it("keeps only ordinary links", () => {
        const html = exports.threadHtml(
            thread("[a](javascript:alert(1)) [b](https://example.test)"),
            NAMES
        );
        expect(html).not.toContain("javascript:");
        expect(html).toContain('href="https://example.test"');
    });
});

describe("the CSV export", () => {
    it("keeps a cell from running as a formula, and quotes it", () => {
        const csv = exports.threadCsv(thread('=HYPERLINK("x")'), NAMES);
        expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    });
});
