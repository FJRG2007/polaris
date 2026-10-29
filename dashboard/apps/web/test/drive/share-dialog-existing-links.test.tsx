// @vitest-environment jsdom

/**
 * The share dialog shows the links that already exist for the item before the
 * form that makes a new one, with the shared-links rows' own actions, and says
 * so when there are none.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const itemLinksAction = vi.fn();
vi.mock("@/app/(app)/drive/share-actions", () => ({
    itemLinksAction: (...args: unknown[]) => itemLinksAction(...args),
    createShareAction: vi.fn(),
    revealShareLinkAction: vi.fn(),
    revokeShareAction: vi.fn(),
    updateShareAction: vi.fn(),
    getShareLogsAction: vi.fn()
}));

const { ShareDialog } = await import("@/app/(app)/drive/share-dialog");

const LINK = {
    id: "share-1",
    path: "Photos/2026",
    kind: "public",
    connectionId: "c1",
    connectionName: "NAS",
    allowUpload: false,
    allowRename: false,
    allowDelete: false,
    allowCreateFolder: false,
    allowOverwrite: false,
    allowDownload: true,
    allowPreview: true,
    allowedCidrs: [],
    allowedCountries: [],
    allowedContinents: [],
    hasPassword: true,
    guards: {},
    maxDownloads: null,
    downloadCount: 4,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    canReveal: true
};

const TARGET = { connectionId: "c1", path: "Photos/2026", name: "2026", isDir: true };

afterEach(() => {
    cleanup();
    itemLinksAction.mockReset();
});

describe("the share dialog's existing links", () => {
    it("lists the item's links with copy, settings, visits and revoke", async () => {
        itemLinksAction.mockResolvedValue({ links: [LINK] });
        render(<ShareDialog targets={[TARGET]} onOpenChange={() => {}} />, {
            wrapper: MessagesWrapper
        });
        const section = await screen.findByRole("region", { name: "Your links to this item" });
        expect(itemLinksAction).toHaveBeenCalledWith({ connectionId: "c1", path: "Photos/2026" });
        await within(section).findByText("Photos/2026");
        for (const name of ["Link", "Logs", "Edit", "Revoke"]) {
            expect(within(section).getByRole("button", { name: new RegExp(name) })).toBeTruthy();
        }
    });

    it("says there are none, and is not shown for several items at once", async () => {
        itemLinksAction.mockResolvedValue({ links: [] });
        const view = render(<ShareDialog targets={[TARGET]} onOpenChange={() => {}} />, {
            wrapper: MessagesWrapper
        });
        expect(await screen.findByText("No links to this item yet.")).toBeTruthy();
        view.rerender(
            <ShareDialog
                targets={[TARGET, { ...TARGET, path: "Photos/2025", name: "2025" }]}
                onOpenChange={() => {}}
            />
        );
        expect(screen.queryByRole("region", { name: "Your links to this item" })).toBeNull();
    });
});
