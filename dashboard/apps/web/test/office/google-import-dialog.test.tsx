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
import { act, cleanup, render, screen } from "@testing-library/react";
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

const { GoogleImportDialog, OFFICE_GOOGLE_LINK, GOOGLE_ANSWER_DEADLINE_MS } = await import(
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
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

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

    it("offers to try again as well as to link again", async () => {
        officeGoogleStateAction.mockResolvedValue({ available: true, accounts: [ACCOUNT] });
        listGoogleFilesAction.mockResolvedValueOnce({ error: "Link it again.", relink: true });
        listGoogleFilesAction.mockResolvedValueOnce({ files: [], next: null });
        mount();
        await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
        expect(await screen.findByText("No Docs, Sheets or Slides in this account")).toBeTruthy();
    });
});

/**
 * The report this guards: an account linked, the dialog opened, and the list
 * skeleton never went away. A server action that rejects (a lost request, a
 * server that answered with an error page) or never answers left `files` at
 * null with nothing to replace it.
 */
describe("the list never sits on a skeleton", () => {
    it("says the list failed, with a retry, when the action rejects", async () => {
        officeGoogleStateAction.mockResolvedValue({ available: true, accounts: [ACCOUNT] });
        listGoogleFilesAction.mockRejectedValueOnce(new Error("An unexpected response"));
        listGoogleFilesAction.mockResolvedValueOnce({
            files: [
                {
                    id: "d1",
                    name: "Quarterly plan",
                    mime: "application/vnd.google-apps.document",
                    modifiedAt: null,
                    importable: true,
                    link: null
                }
            ],
            next: null
        });
        mount();
        expect((await screen.findByRole("alert")).textContent).toContain("Google didn't answer");
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("Quarterly plan")).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says the list failed when the action never answers", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        officeGoogleStateAction.mockResolvedValue({ available: true, accounts: [ACCOUNT] });
        listGoogleFilesAction.mockReturnValue(new Promise(() => undefined));
        mount();
        await vi.waitFor(() => expect(listGoogleFilesAction).toHaveBeenCalled());
        expect(screen.queryByRole("alert")).toBeNull();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(GOOGLE_ANSWER_DEADLINE_MS);
        });
        expect(screen.getByRole("alert").textContent).toContain("Google didn't answer");
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    });

    it("says what failed, with a retry, when the accounts cannot be read", async () => {
        officeGoogleStateAction.mockRejectedValueOnce(new Error("An unexpected response"));
        officeGoogleStateAction.mockResolvedValueOnce({ available: true, accounts: [ACCOUNT] });
        listGoogleFilesAction.mockResolvedValue({ files: [], next: null });
        mount();
        expect((await screen.findByRole("alert")).textContent).toContain("Google didn't answer");
        expect(screen.queryByText(/An administrator can add it/)).toBeNull();
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("No Docs, Sheets or Slides in this account")).toBeTruthy();
    });

    it("shows an empty Drive as empty", async () => {
        officeGoogleStateAction.mockResolvedValue({ available: true, accounts: [ACCOUNT] });
        listGoogleFilesAction.mockResolvedValue({ files: [], next: null });
        mount();
        expect(await screen.findByText("No Docs, Sheets or Slides in this account")).toBeTruthy();
    });
});
