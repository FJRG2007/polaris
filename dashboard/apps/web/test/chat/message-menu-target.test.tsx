// @vitest-environment jsdom

/**
 * What a right-click on a picture offers, the first time.
 *
 * The menu wraps the whole message row, which takes the browser's own menu away
 * - so the picture's own actions have to be in this one, and they have to be in
 * it on the first press. They were not: the gesture was recorded into a ref, the
 * items are React elements built when the row last rendered, and a ref written
 * during an event renders nothing. So the first right-click on a picture drew a
 * menu about the message with nothing about the picture, and the section only
 * appeared once something else re-rendered the row - opening the picture in the
 * viewer, after which it looked correct for ever.
 *
 * That is the shape this pins: press once, on a picture, and read the menu.
 */

import { ToastProvider } from "@polaris/ui";
import userEvent from "@testing-library/user-event";
import type { ChatMessageView } from "@/lib/chat/messages";
import { MessageMenu } from "@/app/(app)/chat/message-menu";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The menu reaches the server only for actions nothing here presses.
vi.mock("@/app/(app)/chat/actions", () => ({}));

beforeAll(() => {
    // What a Radix menu measures itself with, and what jsdom does not ship.
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.scrollIntoView ??= () => {};
});

afterEach(cleanup);

/** A message with a picture on it, in the shape the menu reads. Everything the
 *  menu does not look at is left off rather than invented. */
const MESSAGE = {
    id: "m1",
    channelId: "c1",
    body: "",
    deleted: false,
    forwardable: true,
    attachments: [],
    reactions: []
} as unknown as ChatMessageView;

function menu() {
    return render(
        <ToastProvider>
            <MessageMenu
                actions={{
                    message: MESSAGE,
                    mine: true,
                    canPost: true,
                    canModerate: false,
                    onReply: () => {},
                    onForward: () => {},
                    onReport: () => {},
                    onExplain: () => {}
                    // The rest are optional to the menu and unused here.
                }}
            >
                <div data-testid="row">
                    <img src="/api/chat/attachments/a1" alt="holiday.png" />
                </div>
            </MessageMenu>
        </ToastProvider>
    );
}

describe("the message menu over a picture", () => {
    it("offers the picture's own actions on the first press", async () => {
        menu();
        await userEvent.pointer({
            keys: "[MouseRight]",
            target: screen.getByAltText("holiday.png")
        });
        expect(await screen.findByText("Copy image")).toBeTruthy();
        expect(screen.getByText("Copy media link")).toBeTruthy();
    });

    it("offers nothing about a picture when the press was not on one", async () => {
        menu();
        await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByTestId("row") });
        expect(await screen.findByText(/Reply/)).toBeTruthy();
        expect(screen.queryByText("Copy image")).toBeNull();
    });
});
