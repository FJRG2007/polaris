// @vitest-environment jsdom

/**
 * The Export menu, inside the real document chrome, sees the editor's exporter.
 *
 * The report: in a diagram, "Vector image (.svg)" and "Image (.png)" were always
 * greyed out. The diagram registered its exporter in the slot, but the slot only
 * wrapped the editor below the header - and the Export menu lives in the header,
 * so it read an empty slot every time. Rendered here the way the page renders
 * it: the chrome, with an editor inside that registers.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentChrome } from "@/app/(app)/office/document-chrome";
import { useRegisterExporter } from "@/app/(app)/office/export-slot";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/(app)/office/actions", () => ({
    renameDocumentAction: vi.fn(async () => ({})),
    starDocumentAction: vi.fn(async () => ({}))
}));
vi.mock("@/app/(app)/office/google-actions", () => ({
    officeGoogleLinkAction: vi.fn(async () => ({ link: null })),
    saveToGoogleAction: vi.fn(async () => ({}))
}));
vi.mock("@/app/(app)/office/link-panel", () => ({ OfficeLinkPanel: () => null }));
vi.mock("@/components/access/share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() })
}));

afterEach(cleanup);

const DOCUMENT = {
    id: "doc-fixture-1",
    kind: "diagram" as const,
    title: "Fixture diagram",
    excerpt: "",
    orgId: null,
    orgName: null,
    archived: false,
    trashed: false,
    editedBy: "Fixture Person",
    editedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    openedAt: null,
    starred: false,
    shared: false
};

/** An editor that can draw itself as a picture, as the diagram does. */
function DrawingEditor({ onExport }: { onExport: (format: string) => void }) {
    useRegisterExporter(async (format) => {
        onExport(format);
        return new Blob(["fixture"], { type: format === "svg" ? "image/svg+xml" : "image/png" });
    });
    return <div>canvas</div>;
}

/** Radix opens a menu on the press, not on the click. */
function openMenu(button: HTMLElement) {
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("the document chrome's Export menu", () => {
    it("offers the formats the editor draws in the browser, and runs them", async () => {
        const exported: string[] = [];
        URL.createObjectURL = vi.fn(() => "blob:fixture");
        URL.revokeObjectURL = vi.fn();
        render(
            <DocumentChrome document={DOCUMENT} role="owner" owned>
                <DrawingEditor onExport={(format) => exported.push(format)} />
            </DocumentChrome>,
            { wrapper: MessagesWrapper }
        );

        openMenu(screen.getByRole("button", { name: /export/i }));
        const png = await screen.findByRole("menuitem", { name: /\.png/i });
        await waitFor(() => expect(png.getAttribute("aria-disabled")).not.toBe("true"));

        await act(async () => {
            fireEvent.click(png);
        });
        await waitFor(() => expect(exported).toEqual(["png"]));
    });
});
