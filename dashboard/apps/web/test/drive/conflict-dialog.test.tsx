// @vitest-environment jsdom

/**
 * The "this name is already taken" dialog, as somebody answering it sees it.
 *
 * One clash at a time, with "Apply to all" so a folder of clashes is one
 * answer; Replace offered only where the server said it may be, with the reason
 * where it is not; and Cancel answering nothing at all.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { ClashView } from "@/lib/drive/conflict-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConflictDialog, type ConflictRequest } from "@/app/(app)/drive/conflict-dialog";

afterEach(cleanup);

function clash(path: string, overrides: Partial<ClashView> = {}): ClashView {
    return {
        path,
        incomingKind: "file",
        existingName: path,
        existingKind: "file",
        canReplace: true,
        replaceBlocked: null,
        recoverable: true,
        ...overrides
    };
}

function open(request: ConflictRequest) {
    const onDone = vi.fn();
    render(<ConflictDialog request={request} onDone={onDone} />, { wrapper: MessagesWrapper });
    return onDone;
}

describe("the name clash dialog", () => {
    it("names the file, says the old one goes to the bin, and replaces it", async () => {
        const user = userEvent.setup();
        const onDone = open({ clashes: [clash("report.pdf")], batch: false });
        expect(
            screen.getByText('A file named "report.pdf" is already in this folder.')
        ).toBeTruthy();
        expect(screen.getByText(/moves to the trash, where you can restore it/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Replace" }));
        expect(onDone).toHaveBeenCalledWith(new Map([["report.pdf", "replace"]]));
    });

    it("says plainly when replacing overwrites for good", () => {
        open({ clashes: [clash("a.txt", { recoverable: false })], batch: false });
        expect(
            screen.getByText(/no trash, so the current file is overwritten for good/)
        ).toBeTruthy();
    });

    it("offers only Keep both and Skip, with the reason, when the file is not theirs", async () => {
        const user = userEvent.setup();
        const onDone = open({
            clashes: [clash("a.txt", { canReplace: false, replaceBlocked: "permission" })],
            batch: true
        });
        expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
        expect(
            screen.getByText(/you don't have permission to change the existing file/)
        ).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Keep both" }));
        expect(onDone).toHaveBeenCalledWith(new Map([["a.txt", "keepBoth"]]));
    });

    it("asks about each clash in turn without Apply to all", async () => {
        const user = userEvent.setup();
        const onDone = open({ clashes: [clash("a.txt"), clash("b.txt")], batch: true });
        expect(screen.getByText("1 of 2")).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Skip" }));
        expect(onDone).not.toHaveBeenCalled();
        expect(screen.getByText("2 of 2")).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Keep both" }));
        expect(onDone).toHaveBeenCalledWith(
            new Map([
                ["a.txt", "skip"],
                ["b.txt", "keepBoth"]
            ])
        );
    });

    it("applies one answer to all, but still asks about the one it cannot fit", async () => {
        const user = userEvent.setup();
        const onDone = open({
            clashes: [
                clash("a.txt"),
                clash("b.txt"),
                clash("theirs.txt", { canReplace: false, replaceBlocked: "permission" })
            ],
            batch: true
        });
        await user.click(screen.getByRole("checkbox", { name: "Do this for all 3 items" }));
        await user.click(screen.getByRole("button", { name: "Replace" }));
        expect(onDone).not.toHaveBeenCalled();
        expect(
            screen.getByText('A file named "theirs.txt" is already in this folder.')
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Skip" }));
        expect(onDone).toHaveBeenCalledWith(
            new Map([
                ["a.txt", "replace"],
                ["b.txt", "replace"],
                ["theirs.txt", "skip"]
            ])
        );
    });

    it("offers to merge a folder onto a folder", async () => {
        const user = userEvent.setup();
        const onDone = open({
            clashes: [clash("album", { incomingKind: "dir", existingKind: "dir" })],
            batch: true
        });
        expect(screen.getByText('A folder named "album" is already in this folder.')).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Merge folders" }));
        expect(onDone).toHaveBeenCalledWith(new Map([["album", "merge"]]));
    });

    it("answers nothing on Cancel", async () => {
        const user = userEvent.setup();
        const onDone = open({ clashes: [clash("a.txt"), clash("b.txt")], batch: true });
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onDone).toHaveBeenCalledWith(null);
    });

    it("says when somebody took the name while the file was on its way", () => {
        open({ clashes: [clash("a.txt")], batch: false, late: true });
        expect(
            screen.getByText('"a.txt" was added to this folder while yours was on its way.')
        ).toBeTruthy();
    });

    it("is in Spanish for a Spanish reader", async () => {
        const { withMessages } = await import("../setup/i18n");
        render(
            withMessages(
                <ConflictDialog
                    request={{ clashes: [clash("a.txt")], batch: true }}
                    onDone={() => undefined}
                />,
                "es-ES"
            )
        );
        expect(screen.getByRole("button", { name: "Reemplazar" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Dejar ambos" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Omitir" })).toBeTruthy();
    });
});
