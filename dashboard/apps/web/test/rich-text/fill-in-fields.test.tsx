// @vitest-environment jsdom

/**
 * The fields a rewrite left to fill (`{{label}}`). In the editor each is drawn
 * as a box while the stored Markdown keeps the plain braces; the bar under a
 * field lists them, and picking one selects that field in the text so typing
 * replaces it.
 */

import { useState } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/(app)/mention-actions", () => ({
    resolveReferencesAction: async () => ({}),
    searchMentionsAction: async () => []
}));

const { RichTextEditor } = await import("@/components/rich-text/rich-text-editor");
const { FillInBar } = await import("@/components/polar/fill-in-bar");
const md = await import("@/components/rich-text/markdown");
const { fillInRanges } = await import("@/components/rich-text/fill-in");

afterEach(cleanup);

// jsdom lays nothing out; ProseMirror measures to scroll a selection into view.
if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
if (!Element.prototype.getClientRects)
    Element.prototype.getClientRects = () => [] as unknown as DOMRectList;

const TEXT = "Hola {{Nombre del cliente}}, nos vemos el {{fecha}}.";

describe("fields to fill", () => {
    it("survive the Markdown round trip as plain braces", () => {
        expect(md.docToMarkdown(md.markdownToDoc(TEXT, "https://x"))).toBe(TEXT);
    });

    it("are drawn as boxes in the editor", async () => {
        const { container } = render(<RichTextEditor value={TEXT} />, { wrapper: MessagesWrapper });
        await waitFor(() =>
            expect(container.querySelectorAll("[data-fill-in]").length).toBe(2)
        );
        expect(container.querySelector("[data-fill-in]")?.textContent).toBe("{{Nombre del cliente}}");
    });

    it("are listed under the field, and picking one selects it", async () => {
        let selected = "";
        function Field() {
            const [reveal, setReveal] = useState<{ token: number; label: string } | null>(null);
            return (
                <>
                    <RichTextEditor value={TEXT} reveal={reveal} />
                    <FillInBar
                        text={TEXT}
                        onReveal={(label) => setReveal({ token: Date.now(), label })}
                    />
                </>
            );
        }
        render(<Field />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("status").textContent).toContain("2 fields to fill");
        fireEvent.click(screen.getByRole("button", { name: "fecha" }));
        await waitFor(() => {
            selected = window.getSelection()?.toString() ?? "";
            expect(selected).toBe("{{fecha}}");
        });
    });

    it("finds nothing in a text without fields", () => {
        const doc = md.markdownToDoc("plain {text}", "https://x");
        expect(doc).toBeTruthy();
        render(<FillInBar text="plain {text}" onReveal={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("status")).toBeNull();
        expect(typeof fillInRanges).toBe("function");
    });
});
