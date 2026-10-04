// @vitest-environment jsdom

/**
 * The favorites list does what somebody reaches for on it.
 *
 * The report: from Favorites an item could be neither opened nor unstarred -
 * every row was a link to the folder it sits in. Now the name opens the item, a
 * button shows it in its folder, and the star takes it off the list at once,
 * puts it back if the server refuses, and offers Undo.
 */

import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const setItemFavoriteAction = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/app/(app)/drive/actions", () => ({ setItemFavoriteAction }));

const { FavoritesView, folderHref, openHref } = await import(
    "@/app/(app)/drive/favorites/favorites-view"
);

const report = { connectionId: "c1", connectionName: "NAS", path: "Work/Q3/report.pdf" };
const photos = { connectionId: "c1", connectionName: "NAS", path: "Photos" };

function view(canEdit = true) {
    return render(
        <MessagesWrapper>
            <ToastProvider>
                <FavoritesView favorites={[report, photos]} canEdit={canEdit} />
            </ToastProvider>
        </MessagesWrapper>
    );
}

beforeEach(() => {
    setItemFavoriteAction.mockReset();
    setItemFavoriteAction.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("the favorites list", () => {
    it("opens the item itself from its name, and its folder from the button", () => {
        view();
        expect(screen.getByRole("link", { name: "report.pdf" }).getAttribute("href")).toBe(
            "/drive/open?c=c1&p=Work%2FQ3%2Freport.pdf"
        );
        expect(
            screen.getByRole("link", { name: "Show report.pdf in its folder" }).getAttribute("href")
        ).toBe("/drive?c=c1&p=Work%2FQ3");
        // An item at the root has no parent to name.
        expect(folderHref(photos)).toBe("/drive?c=c1");
        expect(openHref(photos)).toBe("/drive/open?c=c1&p=Photos");
    });

    it("takes the star off on the spot and offers Undo", async () => {
        view();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf from favorites" }));
        });
        expect(setItemFavoriteAction).toHaveBeenCalledWith("c1", "Work/Q3/report.pdf", false);
        expect(screen.queryByRole("link", { name: "report.pdf" })).toBeNull();

        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: "Put it back" }));
        });
        expect(setItemFavoriteAction).toHaveBeenLastCalledWith("c1", "Work/Q3/report.pdf", true);
        await waitFor(() => expect(screen.getByRole("link", { name: "report.pdf" })).toBeTruthy());
    });

    it("puts the row back when the server refuses", async () => {
        setItemFavoriteAction.mockRejectedValue(new Error("no"));
        view();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf from favorites" }));
        });
        expect(screen.getByRole("link", { name: "report.pdf" })).toBeTruthy();
    });

    it("shows the star without offering it to somebody who may not change stars", () => {
        view(false);
        expect(screen.queryByRole("button", { name: /from favorites/ })).toBeNull();
        expect(screen.getByRole("link", { name: "report.pdf" })).toBeTruthy();
    });
});
