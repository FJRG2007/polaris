// @vitest-environment jsdom

/**
 * Deleting a subfolder from inside a folder keeps you in that folder.
 *
 * The job poll starts once, on mount, and used to call the `load` of that first
 * render when a job ended. Opened at My files and then walked into Projects,
 * deleting Projects/Old listed My files again the moment the job finished - the
 * reader was "sent back to the root" while the address still said Projects.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionSummary } from "../../src/app/(app)/drive/types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const RUNNING = { id: "job-1", kind: "trash", total: 1, done: 0 };
let jobsAnswer: unknown[] = [];
vi.mock("../../src/app/(app)/drive/drive-reads", () => ({
    driveJobs: async () => ({ jobs: jobsAnswer, going: [] }),
    unasShares: async () => ({ shares: [] })
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({
        data: [],
        loading: false,
        error: null,
        stale: null,
        refreshing: false,
        updatedAt: null,
        refresh: () => {}
    })
}));
vi.mock("@/components/transfers/move-file", () => ({
    sendFile: (...args: unknown[]) => sendFile(...args)
}));
vi.mock("../../src/app/(app)/drive/actions", () => ({
    driveJobsAction: async () => [],
    startDriveJobAction: async () => ({ job: RUNNING }),
    moveIntoAction: (...args: unknown[]) => moveIntoAction(...args)
}));
// Saving "don't ask again" is a server action file that reaches the session
// as it is imported; nothing here answers that question.
vi.mock("../../src/app/(app)/drive/settings/actions", () => ({
    setConfirmTrashAction: async () => ({ confirmTrash: false })
}));
vi.mock("../../src/app/(app)/drive/conflict-actions", () => ({
    nameClashesAction: (...args: unknown[]) => nameClashesAction(...args),
    reserveFolderAction: (...args: unknown[]) => reserveFolderAction(...args)
}));
vi.mock("../../src/app/(app)/apps/servers/actions", () => ({
    recoverServerAddressAction: () => new Promise(() => {})
}));
// The file view stands in as one button that deletes a subfolder.
vi.mock("../../src/app/(app)/drive/files-view", () => ({
    FilesView: ({ onDelete }: { onDelete?: (entries: unknown[]) => void }) => (
        <button
            type="button"
            onClick={() =>
                onDelete?.([{ name: "Old", path: "Projects/Old", kind: "dir", size: "0" }])
            }
        >
            delete
        </button>
    )
}));
vi.mock("../../src/app/(app)/drive/share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("../../src/app/(app)/drive/send-dialog", () => ({ SendDialog: () => null }));
vi.mock("../../src/app/(app)/drive/transfers-panel", () => ({ TransfersPanel: () => null }));
vi.mock("../../src/app/(app)/drive/people-share-dialog", () => ({ PeopleShareDialog: () => null }));
vi.mock("../../src/app/(app)/drive/request-dialog", () => ({ RequestDialog: () => null }));
vi.mock("../../src/app/(app)/drive/unifi-console-button", () => ({
    UnifiConsoleButton: () => null
}));
vi.mock("../../src/app/(app)/drive/remove-connection-dialog", () => ({
    RemoveConnectionDialog: () => null
}));
vi.mock("../../src/app/(app)/drive/connection-dialog", () => ({
    ConnectionDialog: () => null,
    EditConnectionDialog: () => null
}));
vi.mock("../../src/app/(app)/drive/access-dialog", () => ({
    AccessDialog: () => null,
    UnlockPanel: () => null
}));

const { DriveExplorer } = await import("../../src/app/(app)/drive/drive-explorer");

const NAS: ConnectionSummary = {
    id: "55555555-5555-4555-8555-555555555555",
    name: "office-nas",
    kind: "local",
    requiresHostd: false,
    shared: false,
    canManageAccess: false,
    needsRekey: false
};

const listed: string[] = [];

beforeEach(() => {
    listed.length = 0;
    jobsAnswer = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url.startsWith("/api/drive/list")) {
                listed.push(new URL(url, "http://x").searchParams.get("p") ?? "");
            }
            return new Response(JSON.stringify({ entries: [] }), { status: 200 });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function explorer(path: string) {
    return (
        <DriveExplorer
            connections={[NAS]}
            connectionId={NAS.id}
            path={path}
            abilities={{ read: true, write: true, remove: true }}
            confirmTrash={false}
        />
    );
}

describe("deleting a subfolder from inside a folder", () => {
    it("lists the folder you are in when the job ends, not the one Drive opened on", async () => {
        const user = userEvent.setup();
        const view = render(explorer(""), { wrapper: MessagesWrapper });
        view.rerender(explorer("Projects"));
        await waitFor(() => expect(listed).toContain("Projects"));

        jobsAnswer = [RUNNING];
        await user.click(screen.getByRole("button", { name: "delete" }));
        // The poll sees the job running, then sees it gone.
        await waitFor(() => expect(listed.length).toBeGreaterThan(0));
        listed.length = 0;
        jobsAnswer = [];
        await waitFor(() => expect(listed.length).toBeGreaterThan(0), { timeout: 20_000 });
        expect(listed.every((p) => p === "Projects")).toBe(true);
    }, 30_000);
});
