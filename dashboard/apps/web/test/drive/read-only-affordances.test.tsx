// @vitest-environment jsdom

/**
 * A screen that cannot write does not offer to.
 *
 * Reported from a real deployment: give somebody read-only access to a source and
 * the explorer still shows New folder, Upload, Rename, Move and Delete. Pressing
 * any of them gets an error afterwards, which reads as Polaris being broken
 * rather than as a permission they never had.
 *
 * The server is still the decider - it checks again on every write, and these
 * cases are not a substitute for that. What they pin is that the affordance and
 * the refusal agree, in both directions.
 *
 * The toolbar is what is asserted here rather than the row menu. Both are gated
 * on the same two flags, and a Radix context menu needs a pointer sequence jsdom
 * does not really have - a case that opened one would be a case that fails for
 * reasons having nothing to do with permissions.
 */

import { FilesView } from "@/app/(app)/drive/files-view";
import type { DriveEntry } from "@/app/(app)/drive/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/user-profile-dialog", () => ({ UserProfileDialog: () => null }));
vi.mock("@/app/(app)/drive/actions", () => ({}));
vi.mock("@/app/(app)/drive/share-actions", () => ({}));
vi.mock("@/app/(app)/drive/activity-actions", () => ({}));

// The virtualizer measures its scroll container; jsdom reports every element as
// 0x0, which would window the list down to nothing.
beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 800,
        height: 400,
        top: 0,
        left: 0,
        right: 800,
        bottom: 400,
        x: 0,
        y: 0,
        toJSON() {
            return {};
        }
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

const FILE: DriveEntry = {
    name: "notes.txt",
    path: "notes.txt",
    kind: "file",
    size: "12",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z"
};

const noop = () => {};

function renderAs(abilities: { read: boolean; write: boolean; remove: boolean }) {
    return render(
        <FilesView
            connectionId="c1"
            path=""
            segments={[]}
            entries={[FILE]}
            loading={false}
            error={null}
            pending={false}
            uploading={false}
            fileInput={{ current: null }}
            href={(id, target) => `/drive?c=${id}&p=${target}`}
            abilities={abilities}
            onNewFolder={noop}
            onNewFile={noop}
            onUpload={noop}
            onDelete={noop}
            onRename={noop}
            onToggleHidden={noop}
            onSetFavorite={noop}
            onSetIcon={noop}
            onSetNote={noop}
            onMove={noop}
            onCopy={noop}
            onDeletePermanent={noop}
            onEmptyFolder={noop}
            onScheduleDelete={noop}
        />
    );
}

describe("somebody who may only read", () => {
    it("is not offered New folder", () => {
        renderAs({ read: true, write: false, remove: false });
        expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    });

    it("has Upload there but stood down, with a reason on it", () => {
        // Stood down rather than removed: Upload is the most-looked-for control
        // in a file browser, and a reader who cannot find it at all concludes
        // the screen is broken instead of that they may not use it.
        renderAs({ read: true, write: false, remove: false });
        const upload = screen.getByRole("button", { name: "Upload" });
        expect(upload.hasAttribute("disabled")).toBe(true);
        expect(upload.getAttribute("title")).toContain("not change it");
    });
});

describe("somebody who may write", () => {
    it("gets both back", () => {
        renderAs({ read: true, write: true, remove: true });
        expect(screen.getByRole("button", { name: "New folder" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Upload" }).hasAttribute("disabled")).toBe(false);
    });
});
