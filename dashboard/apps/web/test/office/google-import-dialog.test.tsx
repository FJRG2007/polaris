// @vitest-environment jsdom

/**
 * The dialog a Google Doc or Sheet is brought in through.
 *
 * What it has to get right is the step somebody is on: no Google client here
 * says who adds one, an account linked for something else offers to link it
 * for Drive, and a linked one lists the files - with Slides shown but not
 * pressable, because pressing them would only be refused. A press on a Doc is
 * the import, and lands on the document.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const officeGoogleStateAction = vi.fn();
const listGoogleFilesAction = vi.fn();
const importGoogleFileAction = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: () => undefined }) }));
vi.mock("../../src/app/(app)/office/google-actions", () => ({
    officeGoogleStateAction,
    listGoogleFilesAction,
    importGoogleFileAction
}));

const { GoogleImportDialog, OFFICE_GOOGLE_LINK } = await import(
    "../../src/app/(app)/office/google-import-dialog"
);

const ACCOUNT = { id: "a1", label: "ana@example.test", canImport: true, canSave: true };

function mount() {
    const onClose = vi.fn();
    render(
        <MessagesWrapper>
            <GoogleImportDialog orgId={null} onClose={onClose} />
        </MessagesWrapper>
    );
    return onClose;
}

beforeEach(() => {
    for (const mock of [
        push,
        officeGoogleStateAction,
        listGoogleFilesAction,
        importGoogleFileAction
    ]) {
        mock.mockReset();
    }
});
afterEach(cleanup);

describe("opening from Google Drive", () => {
    it("says who can add Google when this Polaris has none", async () => {
        officeGoogleStateAction.mockResolvedValue({ available: false, accounts: [] });
        mount();
        expect(
            await screen.findByText(/An administrator can add it under Integrations/)
        ).toBeTruthy();
        expect(listGoogleFilesAction).not.toHaveBeenCalled();
    });

    it("offers to link Drive when the account was linked for something else", async () => {
        officeGoogleStateAction.mockResolvedValue({
            available: true,
            accounts: [{ ...ACCOUNT, canImport: false, canSave: false }]
        });
        mount();
        const linkButton = await screen.findByRole("link", { name: "Link Google Drive" });
        expect(linkButton.getAttribute("href")).toBe(OFFICE_GOOGLE_LINK);
        expect(screen.getByText(/not for Drive/)).toBeTruthy();
    });

    it("lists the files, keeps Slides out of reach, and opens a Doc", async () => {
        officeGoogleStateAction.mockResolvedValue({ available: true, accounts: [ACCOUNT] });
        listGoogleFilesAction.mockResolvedValue({
            files: [
                {
                    id: "d1",
                    name: "Quarterly plan",
                    mime: "application/vnd.google-apps.document",
                    modifiedAt: null,
                    importable: true,
                    link: null
                },
                {
                    id: "p1",
                    name: "Launch deck",
                    mime: "application/vnd.google-apps.presentation",
                    modifiedAt: null,
                    importable: false,
                    link: null
                }
            ],
            next: null
        });
        importGoogleFileAction.mockResolvedValue({ id: "doc1", kind: "doc" });
        const onClose = mount();

        const deck = (await screen.findByText("Launch deck")).closest("button");
        expect(deck?.disabled).toBe(true);
        expect(listGoogleFilesAction).toHaveBeenCalledWith({
            connectionId: "a1",
            search: "",
            pageToken: null
        });

        await userEvent.click(screen.getByText("Quarterly plan"));
        expect(importGoogleFileAction).toHaveBeenCalledWith({
            connectionId: "a1",
            fileId: "d1",
            orgId: null
        });
        expect(onClose).toHaveBeenCalled();
        expect(push).toHaveBeenCalledWith(expect.stringContaining("doc1"));
    });

    it("offers to link again when Google wants it, instead of a dead end", async () => {
        officeGoogleStateAction.mockResolvedValue({ available: true, accounts: [ACCOUNT] });
        listGoogleFilesAction.mockResolvedValue({ error: "Link it again.", relink: true });
        mount();
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Link Google Drive" }).getAttribute("href")).toBe(
            OFFICE_GOOGLE_LINK
        );
    });
});
