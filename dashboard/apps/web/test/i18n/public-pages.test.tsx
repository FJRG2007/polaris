// @vitest-environment jsdom

/**
 * The pages somebody outside Polaris reads, drawn in Spanish.
 *
 * A guest has no account, so nothing here is a setting they chose: the page
 * follows their browser. These are the three a stranger is most likely to be
 * sent - a call, a shared folder, a drop point - and each is asserted on the
 * words a reader acts on (the button, the empty folder, why an upload was
 * refused), plus one English check that nothing moved for everybody else.
 */

import { withMessages } from "../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    usePathname: () => "/",
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
// The call itself is the dashboard's and has its own tests; what is under test
// here is the door in front of it.
vi.mock("@/app/(app)/chat/use-call", () => ({ useCall: () => ({ meeting: null }) }));
vi.mock("@/app/(app)/chat/call-room", () => ({ CallRoom: () => null }));
vi.mock("@/app/(app)/chat/call-audio", () => ({ CallAudio: () => null }));
vi.mock("@/app/(app)/chat/call-hotkeys", () => ({ useCallHotkeys: () => undefined }));
vi.mock("@/app/(app)/chat/meeting-chat", () => ({ MeetingChat: () => null }));
vi.mock("@/app/(app)/chat/use-lobby-admission", () => ({ useLobbyAdmission: () => undefined }));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({
    joinAsGuestAction: async () => ({}),
    joinOnLinkAction: async () => ({}),
    readCallAction: async () => ({})
}));
vi.mock("@/app/(app)/drive/file-viewer", () => ({ FileViewer: () => null, isViewable: () => false }));
vi.mock("@/components/transfers/transfers-view", () => ({ TransfersView: () => null }));
vi.mock("@/components/transfers/move-file", () => ({
    saveFile: () => undefined,
    sendFile: async () => ({ ok: true, body: "{}" })
}));
vi.mock("@/components/relative-time", () => ({ RelativeTime: () => null }));

const { GuestCall } = await import("@/app/m/[token]/guest-call");
const { ShareExplorer } = await import("@/app/s/[token]/share-explorer");
const { DropUploader } = await import("@/app/r/[token]/upload-form");

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the guest call page", () => {
    const door = (locale: "en-US" | "es-ES", asAccount = false) =>
        renderToStaticMarkup(
            withMessages(
                <GuestCall token="t" title="" signedIn={false} suggestedName="" asAccount={asAccount} />,
                locale
            )
        );

    it("asks a guest for their name in Spanish", () => {
        const html = door("es-ES");
        expect(html).toContain("Ir a la llamada");
        expect(html).toContain("No hace falta cuenta.");
        expect(html).toContain('placeholder="Tu nombre"');
        expect(html).toContain("Pedir acceso");
        expect(html).not.toContain("Ask to join");
    });

    it("tells somebody signed in that they arrive as themselves", () => {
        const html = door("es-ES", true);
        expect(html).toContain("entras con tu propio nombre");
        expect(html).toContain(">Entrar<");
    });

    it("still says what it always said in English", () => {
        const html = door("en-US");
        expect(html).toContain("Join the call");
        expect(html).toContain("Ask to join");
    });
});

describe("the share explorer", () => {
    const listing = (entries: unknown[]) =>
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify({ entries }), { status: 200 }))
        );

    const explorer = (locale: "en-US" | "es-ES", allowUpload = false) =>
        render(
            withMessages(
                <ShareExplorer
                    token="t"
                    rootName="Fotos"
                    rootPath=""
                    initialPath=""
                    allowDownload
                    allowPreview
                    allowUpload={allowUpload}
                    allowRename={false}
                    allowDelete={false}
                    allowCreateFolder={false}
                />,
                locale
            )
        );

    it("draws its toolbar and an empty folder in Spanish", async () => {
        listing([]);
        explorer("es-ES", true);
        expect(screen.getByPlaceholderText(/^Buscar/)).toBeTruthy();
        expect(screen.getByRole("button", { name: /Filtros/ })).toBeTruthy();
        expect(screen.getByRole("button", { name: /Subir/ })).toBeTruthy();
        await waitFor(() => expect(screen.getByText(/Esta carpeta está vacía\. Suelta archivos aquí/)).toBeTruthy());
        expect(screen.queryByText(/This folder is empty/)).toBeNull();
    });

    it("heads the listing in Spanish once there is something in it", async () => {
        listing([
            {
                name: "playa.jpg",
                path: "playa.jpg",
                kind: "file",
                size: "2048",
                modifiedAt: "2026-09-01T10:00:00Z",
                createdAt: "2026-09-01T10:00:00Z"
            }
        ]);
        explorer("es-ES");
        // The rows are virtualised, and jsdom lays nothing out; the header
        // above them is what arrives with the listing.
        await waitFor(() => expect(screen.getByText("Nombre")).toBeTruthy());
        expect(screen.getByText("Tamaño")).toBeTruthy();
        expect(screen.getByLabelText("Elegir todo")).toBeTruthy();
        expect(screen.getByText("Selecciona elementos para descargarlos, o abre uno para verlo.")).toBeTruthy();
    });

    it("says a folder it could not open in Spanish", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
        explorer("es-ES");
        await waitFor(() => expect(screen.getByText("No se ha podido abrir esta carpeta.")).toBeTruthy());
    });
});

describe("the upload request page", () => {
    const uploader = (locale: "en-US" | "es-ES") =>
        withMessages(
            <DropUploader
                token="t"
                allowedExtensions={["pdf"]}
                deniedExtensions={[]}
                maxSizeBytes={1024}
                minSizeBytes={0}
                allowUploaderDelete={false}
                deleteWindowSeconds={null}
            />,
            locale
        );

    it("invites the visitor to drop files in Spanish", () => {
        const html = renderToStaticMarkup(uploader("es-ES"));
        expect(html).toContain("Suelta archivos aquí o haz clic para elegirlos");
        expect(html).toMatch(/Hasta [^<]+ cada uno/);
    });

    it("says why a file was refused in Spanish", async () => {
        const { container } = render(uploader("es-ES"));
        const input = container.querySelector("input[type=file]") as HTMLInputElement;
        fireEvent.change(input, { target: { files: [new File(["x"], "notas.txt")] } });
        await waitFor(() => expect(screen.getByText("Tipo no permitido")).toBeTruthy());
    });

    it("keeps the English a visitor has always read", () => {
        expect(renderToStaticMarkup(uploader("en-US"))).toContain("Drop files here, or click to choose");
    });
});
