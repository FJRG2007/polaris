/**
 * The folder you are looking at can be shared.
 *
 * Drive offered "Request files here" for the open folder but no way to share the
 * folder itself, so the only link you could mint for where you were standing was
 * a drop point - an upload page, not the folder. This pins that the toolbar and
 * the background right-click both carry a Share action for the current folder,
 * and that it disappears on a source with no saved connection behind it, where a
 * link has nothing to hang off.
 *
 * Rendered to static markup; only the toolbar is under test, so the listing is
 * empty and the dialogs (which live in a portal) never open.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DriveEntry } from "../../src/app/(app)/drive/types";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => {}, refresh: () => {} })
}));
vi.mock("../../src/app/(app)/drive/actions", () => ({}));
// Server actions: importing them for real drags the session and the env in.
vi.mock("../../src/app/(app)/drive/share-actions", () => ({
    createShareAction: async () => ({})
}));
vi.mock("../../src/app/(app)/drive/use-drive-insights", () => ({
    useDriveInsights: () => ({
        sizes: new Map(),
        pending: new Set(),
        locked: new Set(),
        counts: new Map()
    })
}));
vi.mock("../../src/app/(app)/drive/file-viewer", () => ({ FilePreview: () => null }));
vi.mock("../../src/app/(app)/drive/archive-dialog", () => ({ ArchiveDialog: () => null }));
vi.mock("../../src/components/user-profile-dialog", () => ({ UserProfileDialog: () => null }));

const { FilesView } = await import("../../src/app/(app)/drive/files-view");

const ENTRIES: DriveEntry[] = [];

function render(extra: { onShareFolder?: () => void }): string {
    return renderToStaticMarkup(
        <FilesView
            connectionId="44444444-4444-4444-8444-444444444444"
            path="photos/2026"
            segments={["photos", "2026"]}
            entries={ENTRIES}
            loading={false}
            error={null}
            pending={false}
            uploading={false}
            fileInput={{ current: null }}
            href={(id, target) => `/drive?c=${id}&p=${target}`}
            onNewFolder={() => {}}
            onNewFile={() => {}}
            onUpload={() => {}}
            onDelete={() => {}}
            onRename={() => {}}
            onRequestFiles={() => {}}
            onToggleHidden={() => {}}
            onSetFavorite={() => {}}
            onSetIcon={() => {}}
            onSetNote={() => {}}
            onMove={() => {}}
            onCopy={() => {}}
            onDeletePermanent={() => {}}
            onEmptyFolder={() => {}}
            onScheduleDelete={() => {}}
            {...extra}
        />
    );
}

describe("sharing the folder that is open", () => {
    it("offers a link to it beside Request files", () => {
        const markup = render({ onShareFolder: () => {} });

        expect(markup).toContain("Get a link to this folder");
        // The drop point is still there; it is the other thing, not the only thing.
        expect(markup).toContain("Request files");
    });

    it("leaves it out on a source a link cannot hang off", () => {
        const markup = render({});

        expect(markup).not.toContain("Get a link to this folder");
    });

    it("offers giving it to somebody separately from minting a link", () => {
        // Two different questions - who, versus whoever holds this address - and
        // a source can offer one without the other: a link needs a connection to
        // hang off, giving it to a colleague needs the viewer to own the storage.
        const markup = render({ onSharePeopleFolder: () => {} });

        expect(markup).toContain("Share this folder with people");
        expect(markup).not.toContain("Get a link to this folder");
    });
});
