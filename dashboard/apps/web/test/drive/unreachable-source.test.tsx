/**
 * What Drive shows for a source whose machine is not answering.
 *
 * A source is browsed over SFTP or SMB, so when the device is off the listing can
 * only end in a connect timeout and a failure that names nothing. The explorer is
 * told the device is down before it asks, and this pins what it does with that:
 * the rail marks the source and stops opening it - a row that still navigated
 * would spend that timeout and leave the browser waiting on a machine that is not
 * there - the pane says why, and the file browser, with its upload, new folder and
 * delete controls, is not rendered at all rather than rendered over an empty list.
 *
 * A registered server and a saved NAS are both covered: reachability is a
 * property of having a machine, not of which app the source was borrowed from.
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

const NAS: ConnectionSummary = {
    id: "44444444-4444-4444-8444-444444444444",
    name: "unas-pro",
    kind: "unifi-unas",
    requiresHostd: false,
    config: { kind: "unifi-unas", host: "10.0.0.9" },
    shared: false,
    canManageAccess: false,
    needsRekey: false
};

function render(source: ConnectionSummary, status: SourceStatus[]): string {
    statuses = status;
    return renderToStaticMarkup(
        <DriveExplorer connections={[source]} connectionId={source.id} path="" />
    );
}

describe("a Drive source whose machine is down", () => {
    it("says so instead of showing the file browser", () => {
        const markup = render(SERVER, [
            { id: SERVER.id, state: "down", detail: "No answer within 3 seconds" }
        ]);

        expect(markup).toContain("lirio-2 is not answering");
        // The reason the probe gave, not a generic failure.
        expect(markup).toContain("No answer within 3 seconds");
        expect(markup).not.toContain("files-view");
    });

    it("marks it in the connection rail and stops it being opened", () => {
        const markup = render(SERVER, [{ id: SERVER.id, state: "down", detail: null }]);

        expect(markup).toContain("no answer");
        expect(markup).toContain('aria-disabled="true"');
        // No link to browse it: clicking would only buy the connect timeout.
        expect(markup).not.toContain("/drive?c=");
    });

    it("treats a NAS the same as a server", () => {
        const markup = render(NAS, [
            { id: NAS.id, state: "down", detail: "No route to that address" }
        ]);

        expect(markup).toContain("unas-pro is not answering");
        expect(markup).toContain("No route to that address");
        expect(markup).not.toContain("/drive?c=");
        expect(markup).not.toContain("files-view");
    });

    it("browses normally once it answers", () => {
        const markup = render(SERVER, [{ id: SERVER.id, state: "up", detail: null }]);

        expect(markup).toContain("files-view");
        expect(markup).toContain("/drive?c=");
        expect(markup).not.toContain("is not answering");
    });

    it("browses while the probe has not answered yet", () => {
        const markup = render(SERVER, []);

        expect(markup).toContain("files-view");
    });
});
