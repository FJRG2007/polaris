// @vitest-environment jsdom

/**
 * The shared-links edit dialog draws the same Advanced section as the create
 * dialog, filled in with what the link already has: its start, expiry, cap,
 * weekly hours, sign-in and named people. Save stays off until a value differs
 * from the stored one, goes off again when the edit is put back, and hands the
 * list the whole edit in the shape the server's schema takes.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../src/app/(app)/drive/share-actions", () => ({
    revealShareLinkAction: vi.fn(),
    revokeShareAction: vi.fn(),
    updateShareAction: vi.fn()
}));
vi.mock("../../src/app/(app)/drive/drive-reads", () => ({ shareLogs: vi.fn() }));
vi.mock("@/app/(app)/mention-actions", () => ({
    searchAccountsAction: async () => ({ results: [] })
}));

const { EditShareDialog } =
    await import("../../src/app/(app)/drive/shared-links/shared-links-view");
type ShareRow = import("../../src/app/(app)/drive/shared-links/shared-links-view").ShareRow;

afterEach(cleanup);

const SCHEDULE = { days: 62, startMinute: 540, endMinute: 1080, timeZone: "Europe/Madrid" };

const guarded = (): ShareRow => ({
    id: "share-1",
    path: "/reports/q3.pdf",
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
    allowedCidrs: ["10.0.0.0/24"],
    allowedCountries: ["ES"],
    allowedContinents: [],
    hasPassword: true,
    guards: {
        startsAt: new Date(2026, 10, 1).toISOString(),
        schedule: SCHEDULE,
        requireLogin: true,
        allowedUsers: ["ana", "bea@example.test"]
    },
    maxDownloads: 5,
    downloadCount: 1,
    expiresAt: new Date(2026, 11, 31, 23, 59).toISOString(),
    revokedAt: null,
    createdAt: new Date(2026, 9, 1).toISOString(),
    canReveal: true
});

function open(share: ShareRow, onSave = vi.fn()) {
    render(
        <MessagesWrapper>
            <EditShareDialog share={share} onOpenChange={() => undefined} onSave={onSave} />
        </MessagesWrapper>
    );
    return onSave;
}

const field = (id: string) => document.getElementById(`drive-share-edit-${id}`) as HTMLInputElement;
const save = () => screen.getByRole("button", { name: /save/i });

describe("EditShareDialog", () => {
    it("opens with every stored rule filled in", () => {
        open(guarded());
        expect(field("starts").value).toBe("2026-11-01");
        expect(field("expires").value).toBe("2026-12-31");
        expect(field("uses").value).toBe("5");
        expect(field("from").value).toBe("09:00");
        expect(field("to").value).toBe("18:00");
        expect(field("password").value).toBe("");
        expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
        expect(field("people").value).toBe("ana, bea@example.test");
        expect(document.body.textContent).toContain("10.0.0.0/24");
        expect(document.body.textContent).toContain("Spain");
    });

    it("keeps Save off until something changes, and off again when it is put back", () => {
        open(guarded());
        expect(save()).toHaveProperty("disabled", true);
        fireEvent.change(field("uses"), { target: { value: "9" } });
        expect(save()).toHaveProperty("disabled", false);
        fireEvent.change(field("uses"), { target: { value: "5" } });
        expect(save()).toHaveProperty("disabled", true);
        fireEvent.click(screen.getByRole("checkbox", { name: /deleting/i }));
        expect(save()).toHaveProperty("disabled", false);
    });

    it("hands the list the whole edit and the row it leaves behind", () => {
        const onSave = open(guarded());
        fireEvent.change(field("uses"), { target: { value: "9" } });
        fireEvent.click(save());
        expect(onSave).toHaveBeenCalledTimes(1);
        const [row, edit] = onSave.mock.calls[0] as [ShareRow, Record<string, unknown>];
        expect(edit).toMatchObject({
            maxDownloads: 9,
            allowedCidrs: ["10.0.0.0/24"],
            allowedCountries: ["ES"],
            requireLogin: true,
            allowedUsers: ["ana", "bea@example.test"],
            allowDownload: true,
            allowDelete: false
        });
        expect(edit.schedule).toMatchObject({ days: 62, startMinute: 540, endMinute: 1080 });
        expect(edit.startsAt).toBe(new Date(2026, 10, 1).toISOString());
        expect(edit).not.toHaveProperty("password");
        expect(edit).not.toHaveProperty("maxViews");
        expect(row.maxDownloads).toBe(9);
        expect(row.hasPassword).toBe(true);
    });
});
