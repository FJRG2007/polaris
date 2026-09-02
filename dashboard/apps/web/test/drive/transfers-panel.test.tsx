// @vitest-environment jsdom

/**
 * The panel of offers waiting for you, as somebody actually sees it.
 *
 * Deliberately not a notification: what you see before answering is the name,
 * whether it is a folder, its size, who sent it and what they said - and the
 * accept button must answer the OFFER, not the account looking at it. That is
 * the shape of a bug that once shipped here: the accept action took the account
 * and the offer the wrong way round, and because both are strings it compiled.
 */

import userEvent from "@testing-library/user-event";
import type { TransferView } from "@/lib/drive-transfer-service";
import { TransfersPanel } from "@/app/(app)/drive/transfers-panel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const acceptTransferAction = vi.fn();
const declineTransferAction = vi.fn();
const cancelTransferAction = vi.fn();
const sentTransfersAction = vi.fn();
const waitingTransfersAction = vi.fn();

vi.mock("@/app/(app)/drive/transfer-actions", () => ({
    acceptTransferAction: (...args: unknown[]) => acceptTransferAction(...args),
    cancelTransferAction: (...args: unknown[]) => cancelTransferAction(...args),
    declineTransferAction: (...args: unknown[]) => declineTransferAction(...args),
    sentTransfersAction: (...args: unknown[]) => sentTransfersAction(...args),
    waitingTransfersAction: (...args: unknown[]) => waitingTransfersAction(...args)
}));

const OFFER: TransferView = {
    id: "018f2b7a-0000-7000-8000-0000000000f1",
    name: "Q3 contract.pdf",
    isFolder: false,
    size: "204800",
    mode: "copy",
    note: "the signed one",
    status: "pending",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    expiresAt: new Date("2026-08-15T00:00:00Z"),
    landedPath: null,
    failure: null,
    senderId: "018f2b7a-0000-7000-8000-0000000000a1",
    senderName: "Ada Lovelace",
    recipientOrg: null
};

afterEach(cleanup);

beforeEach(() => {
    vi.clearAllMocks();
    waitingTransfersAction.mockResolvedValue([OFFER]);
    sentTransfersAction.mockResolvedValue([]);
});

describe("what somebody has been sent", () => {
    it("shows who sent it and what they said before it can be accepted", async () => {
        render(<TransfersPanel />);
        expect(await screen.findByText("Q3 contract.pdf")).toBeTruthy();
        expect(screen.getByText(/Ada Lovelace/)).toBeTruthy();
        expect(screen.getByText("the signed one")).toBeTruthy();
    });

    it("accepts the offer that was shown, not the account looking at it", async () => {
        // The regression this guards: acceptTransfer(transferId, userId) called
        // the wrong way round would pass the session id here instead.
        acceptTransferAction.mockResolvedValue({ path: "Q3 contract.pdf" });
        const user = userEvent.setup();
        render(<TransfersPanel />);
        await user.click(await screen.findByRole("button", { name: "Accept" }));
        await waitFor(() => expect(acceptTransferAction).toHaveBeenCalledWith(OFFER.id));
    });

    it("declines the offer that was shown", async () => {
        declineTransferAction.mockResolvedValue({});
        const user = userEvent.setup();
        render(<TransfersPanel />);
        await user.click(await screen.findByRole("button", { name: "Decline" }));
        await waitFor(() => expect(declineTransferAction).toHaveBeenCalledWith(OFFER.id));
    });

    it("says nothing has left your Drive while an offer you made waits", async () => {
        waitingTransfersAction.mockResolvedValue([]);
        sentTransfersAction.mockResolvedValue([{ ...OFFER, id: "sent-1", mode: "move" }]);
        render(<TransfersPanel />);
        expect(
            await screen.findByText("Waiting to be answered. Nothing has left your Drive.")
        ).toBeTruthy();
        expect(screen.getByText("Sending it")).toBeTruthy();
    });

    it("is nothing at all when there is nothing waiting and nothing sent", async () => {
        waitingTransfersAction.mockResolvedValue([]);
        sentTransfersAction.mockResolvedValue([]);
        const { container } = render(<TransfersPanel />);
        await waitFor(() => expect(container.innerHTML).toBe(""));
    });
});
