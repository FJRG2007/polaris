// @vitest-environment jsdom

/**
 * Dropping files on a folder that already has some of those names, end to end
 * through the explorer: the check, the dialog, and what each upload is then
 * sent with.
 *
 * The report this answers: an upload onto a taken name used to go straight
 * through and replace the file. Now nothing is sent until the person has
 * answered; skipped files are not sent at all; and a name somebody takes while
 * the files are on their way (a 409) is asked about again rather than lost.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionSummary } from "../../src/app/(app)/drive/types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const nameClashesAction = vi.fn();
const reserveFolderAction = vi.fn();
const sendFile = vi.fn();
let dropped: { file: File; relPath: string }[] = [];
const moveIntoAction = vi.fn();
const moving = [
    { name: "a.txt", path: "inbox/a.txt", kind: "file" },
    { name: "b.txt", path: "inbox/b.txt", kind: "file" }
];

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
    startDriveJobAction: async () => ({}),
    moveIntoAction: (...args: unknown[]) => moveIntoAction(...args)
}));
vi.mock("../../src/app/(app)/drive/conflict-actions", () => ({
    nameClashesAction: (...args: unknown[]) => nameClashesAction(...args),
    reserveFolderAction: (...args: unknown[]) => reserveFolderAction(...args)
}));
vi.mock("../../src/app/(app)/apps/servers/actions", () => ({
    recoverServerAddressAction: () => new Promise(() => {})
}));
// The file view stands in as one button that drops the files, which is all the
// explorer ever receives from it.
vi.mock("../../src/app/(app)/drive/files-view", () => ({
    FilesView: ({
        onUpload,
        onMove
    }: {
        onUpload: (items: typeof dropped) => void;
        onMove: (entries: typeof moving, dest: string) => void;
    }) => (
        <>
            <button type="button" onClick={() => onUpload(dropped)}>
                drop
            </button>
            <button type="button" onClick={() => onMove(moving, "docs")}>
                move
            </button>
        </>
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

function clash(path: string, incomingKind: "file" | "dir" = "file") {
    return {
        path,
        incomingKind,
        existingName: path,
        existingKind: incomingKind,
        canReplace: true,
        replaceBlocked: null,
        recoverable: true
    };
}

function file(relPath: string) {
    return { file: new File(["x"], relPath.split("/").pop() ?? relPath), relPath };
}

/** What each upload was sent as: its name and the conflict mode. */
function sent(): [string, string][] {
    return sendFile.mock.calls.map(([url]) => {
        const query = new URL(String(url), "https://polaris.test").searchParams;
        return [query.get("name") ?? "", query.get("conflict") ?? ""];
    });
}

afterEach(cleanup);

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 }))
    );
    sendFile.mockResolvedValue({ ok: true, status: 200, body: "{}" });
});

function explorer() {
    render(
        <DriveExplorer
            connections={[NAS]}
            connectionId={NAS.id}
            path="docs"
            abilities={{ read: true, write: true, remove: true }}
        />,
        {
            wrapper: MessagesWrapper
        }
    );
}

describe("uploading onto names already taken", () => {
    it("sends nothing until asked, then applies one answer to all", async () => {
        const user = userEvent.setup();
        dropped = [file("a.txt"), file("b.txt"), file("free.txt")];
        nameClashesAction.mockResolvedValue({ clashes: [clash("a.txt"), clash("b.txt")] });
        explorer();
        await user.click(screen.getByRole("button", { name: "drop" }));

        await screen.findByText("2 names are already taken here");
        expect(sendFile).not.toHaveBeenCalled();
        expect(nameClashesAction).toHaveBeenCalledWith(
            expect.objectContaining({ connectionId: NAS.id, folder: "docs", merge: true })
        );
        await user.click(screen.getByRole("checkbox", { name: "Do this for all 2 items" }));
        await user.click(screen.getByRole("button", { name: "Keep both" }));

        await waitFor(() => expect(sendFile).toHaveBeenCalledTimes(3));
        expect(sent()).toEqual([
            ["a.txt", "keepBoth"],
            ["b.txt", "keepBoth"],
            ["free.txt", "fail"]
        ]);
    });

    it("does not send a skipped file, and sends a replaced one as replace", async () => {
        const user = userEvent.setup();
        dropped = [file("a.txt"), file("b.txt")];
        nameClashesAction.mockResolvedValue({ clashes: [clash("a.txt"), clash("b.txt")] });
        explorer();
        await user.click(screen.getByRole("button", { name: "drop" }));
        await user.click(await screen.findByRole("button", { name: "Skip" }));
        await user.click(screen.getByRole("button", { name: "Replace" }));
        await waitFor(() => expect(sendFile).toHaveBeenCalledTimes(1));
        expect(sent()).toEqual([["b.txt", "replace"]]);
    });

    it("sends nothing at all when the question is cancelled", async () => {
        const user = userEvent.setup();
        dropped = [file("a.txt"), file("free.txt")];
        nameClashesAction.mockResolvedValue({ clashes: [clash("a.txt")] });
        explorer();
        await user.click(screen.getByRole("button", { name: "drop" }));
        await user.click(await screen.findByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(sendFile).not.toHaveBeenCalled();
    });

    it("asks again when the name is taken while the file is on its way", async () => {
        const user = userEvent.setup();
        dropped = [file("late.txt")];
        nameClashesAction.mockResolvedValue({ clashes: [] });
        sendFile
            .mockResolvedValueOnce({
                ok: false,
                status: 409,
                body: JSON.stringify({ error: "name_conflict", clash: clash("late.txt") })
            })
            .mockResolvedValueOnce({ ok: true, status: 200, body: "{}" });
        explorer();
        await user.click(screen.getByRole("button", { name: "drop" }));
        await screen.findByText('"late.txt" was added to this folder while yours was on its way.');
        await user.click(screen.getByRole("button", { name: "Keep both" }));
        await waitFor(() => expect(sendFile).toHaveBeenCalledTimes(2));
        expect(sent()).toEqual([
            ["late.txt", "fail"],
            ["late.txt", "keepBoth"]
        ]);
    });

    it("keeps both folders by uploading into the new one's name", async () => {
        const user = userEvent.setup();
        dropped = [file("album/one.jpg")];
        nameClashesAction.mockResolvedValue({ clashes: [clash("album", "dir")] });
        reserveFolderAction.mockResolvedValue({ name: "album (1)" });
        explorer();
        await user.click(screen.getByRole("button", { name: "drop" }));
        await user.click(await screen.findByRole("button", { name: "Keep both" }));
        await waitFor(() => expect(sendFile).toHaveBeenCalledTimes(1));
        expect(sent()).toEqual([["album (1)/one.jpg", "fail"]]);
    });

    it("on merge, asks about the files that are in both folders", async () => {
        const user = userEvent.setup();
        dropped = [file("album/one.jpg"), file("album/two.jpg")];
        nameClashesAction
            .mockResolvedValueOnce({ clashes: [clash("album", "dir")] })
            .mockResolvedValueOnce({ clashes: [clash("album/one.jpg")] });
        explorer();
        await user.click(screen.getByRole("button", { name: "drop" }));
        await user.click(await screen.findByRole("button", { name: "Merge folders" }));
        await screen.findByText('A file named "album/one.jpg" is already in this folder.');
        await user.click(screen.getByRole("button", { name: "Replace" }));
        await waitFor(() => expect(sendFile).toHaveBeenCalledTimes(2));
        expect(sent()).toEqual([
            ["album/one.jpg", "replace"],
            ["album/two.jpg", "fail"]
        ]);
    });
});

describe("moving onto names already taken", () => {
    it("asks first, and moves each item the way the person chose", async () => {
        const user = userEvent.setup();
        nameClashesAction.mockResolvedValue({ clashes: [clash("a.txt")] });
        moveIntoAction.mockResolvedValue({});
        explorer();
        await user.click(screen.getByRole("button", { name: "move" }));
        await screen.findByText('A file named "a.txt" is already in this folder.');
        expect(moveIntoAction).not.toHaveBeenCalled();
        expect(nameClashesAction).toHaveBeenCalledWith(
            expect.objectContaining({ folder: "docs", merge: false })
        );
        await user.click(screen.getByRole("button", { name: "Replace" }));
        await waitFor(() => expect(moveIntoAction).toHaveBeenCalledTimes(2));
        expect(moveIntoAction.mock.calls).toEqual([
            [NAS.id, "inbox/a.txt", "docs", "replace"],
            [NAS.id, "inbox/b.txt", "docs", "fail"]
        ]);
    });

    it("asks again when a move finds the name taken after the check", async () => {
        const user = userEvent.setup();
        nameClashesAction.mockResolvedValue({ clashes: [] });
        moveIntoAction.mockResolvedValueOnce({ conflict: clash("a.txt") }).mockResolvedValue({});
        explorer();
        await user.click(screen.getByRole("button", { name: "move" }));
        await screen.findByText('"a.txt" was added to this folder while yours was on its way.');
        await user.click(screen.getByRole("button", { name: "Keep both" }));
        await waitFor(() => expect(moveIntoAction).toHaveBeenCalledTimes(3));
        expect(
            moveIntoAction.mock.calls
                .filter(([, from]) => from === "inbox/a.txt")
                .map((call) => call[3])
        ).toEqual(["fail", "keepBoth"]);
    });
});
