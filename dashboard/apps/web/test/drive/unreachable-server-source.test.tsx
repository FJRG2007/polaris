/**
 * What Drive shows for a server that is not answering.
 *
 * A registered server is browsed over SFTP, so when the machine is off the
 * listing can only end in a connect timeout and a failure that names nothing.
 * The explorer is told the server is down before it asks, and this pins what it
 * does with that: the rail marks the source, the pane says why, and the file
 * browser - with its upload, new folder and delete controls - is not rendered
 * at all rather than rendered over an empty list.
 *
 * Rendered to static markup; the file view and the dialogs are stubbed because
 * none of them takes part in the decision.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionSummary, SourceStatus } from "../../src/app/(app)/drive/types";

let statuses: SourceStatus[] = [];

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({
        data: statuses,
        loading: false,
        error: null,
        stale: null,
        refreshing: false,
        updatedAt: null,
        refresh: () => {}
    })
}));
vi.mock("../../src/app/(app)/drive/actions", () => ({}));
vi.mock("../../src/app/(app)/drive/files-view", () => ({
    FilesView: () => <div data-testid="files-view" />
}));
vi.mock("../../src/app/(app)/drive/share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("../../src/app/(app)/drive/request-dialog", () => ({ RequestDialog: () => null }));
vi.mock("../../src/app/(app)/drive/unifi-console-button", () => ({ UnifiConsoleButton: () => null }));
vi.mock("../../src/app/(app)/drive/remove-connection-dialog", () => ({ RemoveConnectionDialog: () => null }));
vi.mock("../../src/app/(app)/drive/connection-dialog", () => ({
    ConnectionDialog: () => null,
    EditConnectionDialog: () => null
}));
vi.mock("../../src/app/(app)/drive/access-dialog", () => ({
    AccessDialog: () => null,
    UnlockPanel: () => null
}));

const { DriveExplorer } = await import("../../src/app/(app)/drive/drive-explorer");

const SERVER: ConnectionSummary = {
    id: "host:33333333-3333-4333-8333-333333333333",
    name: "lirio-2",
    kind: "sftp",
    requiresHostd: false,
    shared: false,
    canManageAccess: false,
    needsRekey: false
};

function render(status: SourceStatus[]): string {
    statuses = status;
    return renderToStaticMarkup(
        <DriveExplorer connections={[SERVER]} connectionId={SERVER.id} path="" />
    );
}

describe("a Drive source whose server is down", () => {
    it("says so instead of showing the file browser", () => {
        const markup = render([
            { id: SERVER.id, state: "down", detail: "No answer within 3 seconds" }
        ]);

        expect(markup).toContain("lirio-2 is not answering");
        // The reason the probe gave, not a generic failure.
        expect(markup).toContain("No answer within 3 seconds");
        expect(markup).not.toContain("files-view");
    });

    it("marks it in the connection rail", () => {
        const markup = render([{ id: SERVER.id, state: "down", detail: null }]);

        expect(markup).toContain("no answer");
    });

    it("browses normally once it answers", () => {
        const markup = render([{ id: SERVER.id, state: "up", detail: null }]);

        expect(markup).toContain("files-view");
        expect(markup).not.toContain("is not answering");
    });

    it("browses while the probe has not answered yet", () => {
        const markup = render([]);

        expect(markup).toContain("files-view");
    });
});
