/**
 * Drive, Notes and Office in Spanish: what a reader sees on these screens comes
 * from the catalogs in their language - plurals and arguments included - and
 * the English stays what it was.
 */

import { describe, expect, it, vi } from "vitest";
import { withMessages } from "../../setup/i18n";
import { webCatalogs } from "../../../messages";
import { renderToStaticMarkup } from "react-dom/server";
import { UnlockPanel } from "@/app/(app)/drive/access-dialog";

// The panel is drawn, never submitted: its server actions are not reached.
vi.mock("@/app/(app)/drive/access-actions", () => ({}));
vi.mock("@/app/(app)/drive/principal-picker", () => ({ PrincipalPicker: () => null }));
import { matchSummary, zoomLabel } from "@/app/(app)/drive/viewer/pdf-controls";
import { OFFICE_KIND_KEYS, OFFICE_KIND_PLURAL_KEYS } from "@/app/(app)/office/office-kinds";

describe("Drive in Spanish", () => {
    it("asks for a locked folder's password in Spanish", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <UnlockPanel connectionId="c" lockId="l" lockPath="Fotos" onUnlocked={() => undefined} />,
                "es-ES"
            )
        );
        expect(html).toContain("Esta ubicación está bloqueada");
        expect(html).toContain('placeholder="Contraseña"');
        expect(html).toContain("Abrir");
    });

    it("keeps the English panel as it was", () => {
        const html = renderToStaticMarkup(
            withMessages(<UnlockPanel connectionId="c" lockId="l" lockPath="Fotos" onUnlocked={() => undefined} />)
        );
        expect(html).toContain("This location is locked");
        expect(html).toContain("Unlock");
    });

    it("counts with the plural in place", () => {
        const drive = webCatalogs.translator("es-ES", "drive");
        expect(drive("errors.jobTrash", { count: 1 })).toBe("Moviendo 1 elemento a la papelera");
        expect(drive("errors.jobTrash", { count: 3 })).toBe("Moviendo 3 elementos a la papelera");
        expect(drive("sharedLinks.downloads", { count: 4 })).toBe("4 descargas");

        const en = webCatalogs.translator("en-US", "drive");
        expect(en("errors.jobTrash", { count: 1 })).toBe("Moving 1 item to Trash");
        expect(en("errors.jobDelete", { count: 2 })).toBe("Deleting 2 items permanently");

        const points = webCatalogs.translator("es-ES", "drivePoints");
        expect(points("deleteDialog.files", { count: 0 })).toBe(" - vacía");
        expect(points("deleteDialog.files", { count: 2 })).toBe(" - 2 archivos recogidos");
    });

    it("reads the PDF viewer's zoom and search count in Spanish", () => {
        const t = webCatalogs.translator("es-ES", "driveViewer");
        expect(zoomLabel(t, 1, "page-width")).toBe("Al ancho");
        expect(zoomLabel(t, 1.5)).toBe("150%");
        expect(matchSummary(t, "found", 2, 9)).toBe("2 de 9");
        expect(matchSummary(t, "not-found", 0, 0)).toBe("0 resultados");
    });
});

describe("Notes and Office in Spanish", () => {
    it("names what a note import brought in", () => {
        const notes = webCatalogs.translator("es-ES", "notes");
        expect(notes("notebook.imported", { notes: 1, folders: 0 })).toBe("Una nota.");
        expect(notes("notebook.imported", { notes: 5, folders: 2 })).toBe("5 notas en 2 carpetas.");

        const en = webCatalogs.translator("en-US", "notes");
        expect(en("notebook.imported", { notes: 5, folders: 1 })).toBe("5 notes in one folder.");
    });

    it("names each kind of document", () => {
        const office = webCatalogs.translator("es-ES", "office");
        expect(office(OFFICE_KIND_KEYS.doc)).toBe("Documento");
        expect(office(OFFICE_KIND_PLURAL_KEYS.comparison)).toBe("Comparativas");
        expect(office("links.opened", { count: 3 })).toBe(", abierto 3 veces");
    });
});
