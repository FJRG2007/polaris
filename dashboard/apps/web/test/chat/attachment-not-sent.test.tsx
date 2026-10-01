// @vitest-environment jsdom

/**
 * A picture that did not go.
 *
 * The report: somebody sent an image, the bar in the corner sat at "0 seconds
 * left", the message never arrived, and nothing said so - the file had already
 * gone from the composer, so there was nothing left to try again with. The NAS
 * behind the upload was switched off and the server never answered.
 *
 * What is pinned here is the composer's half: a message with a file stays under
 * the box while it is on its way, says "saving it on the server" once every byte
 * has gone, and when the server says no - or never says anything - it stays with
 * the reason on it and a Retry and a Remove. It is never posted without its file.
 */

import { MessagesWrapper } from "../setup/i18n";
import { DEFAULT_CHAT_RULES } from "@polaris/core";
import { Composer } from "@/app/(app)/chat/composer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendOutcome, SendProgress } from "@/app/(app)/chat/outgoing";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    typingAction: async () => undefined
}));

afterEach(cleanup);

if (!document.elementFromPoint) document.elementFromPoint = () => null;
if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;

async function editableSurface(container: HTMLElement): Promise<HTMLElement> {
    return waitFor(() => {
        const found = container.querySelector<HTMLElement>(".ProseMirror");
        if (!found) throw new Error("the editor did not mount");
        return found;
    });
}

function pasteFiles(target: Element, files: File[]) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
        value: { files, items: [], types: [], getData: () => "" }
    });
    target.dispatchEvent(event);
}

/** A file the composer draws as a chip, which keeps the test off object URLs. */
function sheet(): File {
    return new File(["a,b,c"], "numbers.csv", { type: "text/csv" });
}

type Send = (
    body: string,
    files: readonly File[],
    sounds?: unknown,
    spoilers?: unknown,
    fromDrive?: unknown,
    report?: (progress: SendProgress) => void
) => Promise<SendOutcome>;

/** A send the test answers by hand, so every state in between can be looked at. */
function heldSend() {
    const calls: {
        files: readonly File[];
        report?: (progress: SendProgress) => void;
        answer: (outcome: SendOutcome) => void;
    }[] = [];
    const send = vi.fn<Send>(
        (_body, files, _sounds, _spoilers, _fromDrive, report) =>
            new Promise<SendOutcome>((resolve) => {
                calls.push({ files, report, answer: resolve });
            })
    );
    return { send, calls };
}

/** A conversation of its own per test: what is on its way outlives the box it
 *  was sent from, by design, so one test's failure must not be another's. */
let conversations = 0;

function box(send: Send, channelId: string) {
    return (
        <Composer
            channelId={channelId}
            rules={DEFAULT_CHAT_RULES}
            disabled={false}
            placeholder="Message"
            onSend={send}
        />
    );
}

async function stageAndSend(send: Send): Promise<{ channelId: string; unmount: () => void }> {
    conversations += 1;
    const channelId = `c${conversations}`;
    const { container, unmount } = render(box(send, channelId), { wrapper: MessagesWrapper });
    const editable = await editableSurface(container);
    pasteFiles(editable, [sheet()]);
    await screen.findByText("numbers.csv");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    return { channelId, unmount };
}

describe("a message with a file on its way", () => {
    it("says how far it has got, and that the server is saving it once every byte has gone", async () => {
        const { send, calls } = heldSend();
        await stageAndSend(send);

        await waitFor(() => expect(calls).toHaveLength(1));
        expect(screen.getByRole("status").textContent).toBe("Sending");

        act(() => calls[0]!.report?.({ file: 0, files: 1, moved: 40, total: 100 }));
        expect(screen.getByRole("status").textContent).toBe("Sending - 40%");

        // The bytes are all gone and no answer yet: that is not "0 seconds left".
        act(() => calls[0]!.report?.({ file: 0, files: 1, moved: 100, total: 100 }));
        expect(screen.getByRole("status").textContent).toBe("Saving it on the server");

        await act(async () => calls[0]!.answer(undefined));
        // Landed, so nothing is left under the box.
        await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
        expect(screen.queryByText("numbers.csv")).toBeNull();
    });

    it("stays with the reason when the server refuses it, and can be sent again", async () => {
        const { send, calls } = heldSend();
        await stageAndSend(send);
        await waitFor(() => expect(calls).toHaveLength(1));

        await act(async () =>
            calls[0]!.answer({
                error: "Files cannot be saved right now: the storage UNAS Pro is not reachable."
            })
        );

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain("the storage UNAS Pro is not reachable");
        // The file is still in front of the sender.
        expect(screen.getByText("numbers.csv")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Try sending numbers.csv again" }));
        await waitFor(() => expect(calls).toHaveLength(2));
        // The same file, not a message without it.
        expect(calls[1]!.files.map((file) => file.name)).toEqual(["numbers.csv"]);
        expect(screen.queryByRole("alert")).toBeNull();

        await act(async () => calls[1]!.answer(undefined));
        await waitFor(() => expect(screen.queryByText("numbers.csv")).toBeNull());
    });

    it("can be given up on, which takes the file away and sends nothing", async () => {
        const { send, calls } = heldSend();
        await stageAndSend(send);
        await waitFor(() => expect(calls).toHaveLength(1));
        await act(async () => calls[0]!.answer({ error: "numbers.csv was refused" }));

        fireEvent.click(
            await screen.findByRole("button", { name: "Remove numbers.csv and do not send it" })
        );
        expect(screen.queryByText("numbers.csv")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("says it was not sent when the send itself throws", async () => {
        const send = vi.fn<Send>(async () => {
            throw new Error("network");
        });
        await stageAndSend(send);
        expect((await screen.findByRole("alert")).textContent).toBe("This was not sent.");
        expect(screen.getByRole("button", { name: "Try sending numbers.csv again" })).toBeTruthy();
    });

    it("is still there after walking away and coming back", async () => {
        // Somebody sends a picture and goes to another conversation while it
        // goes. The box it was sent from is gone; the failure must not be.
        const { send, calls } = heldSend();
        const { channelId, unmount } = await stageAndSend(send);
        await waitFor(() => expect(calls).toHaveLength(1));
        unmount();

        await act(async () =>
            calls[0]!.answer({ error: "numbers.csv was sent, but the server did not answer." })
        );

        render(box(send, channelId), { wrapper: MessagesWrapper });
        expect((await screen.findByRole("alert")).textContent).toContain("did not answer");
        expect(screen.getByRole("button", { name: "Try sending numbers.csv again" })).toBeTruthy();
    });
});
