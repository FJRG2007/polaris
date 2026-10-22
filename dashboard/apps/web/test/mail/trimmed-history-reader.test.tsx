// @vitest-environment jsdom

/**
 * The reading pane draws a reply without the conversation it quotes, and the
 * "..." under it brings that back - through the same sanitizer and the same
 * frame as the rest of the message.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBody } from "@/app/(app)/mail/message-body";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

function frameSource(container: HTMLElement): string {
    return container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

const REPLY =
    '<div>Thanks, see you then!</div><img src="x" onerror="alert(1)"><div class="gmail_quote"><div class="gmail_attr">On Mon, Ann wrote:</div><blockquote class="gmail_quote">Shall we meet?<img src="y" onerror="alert(2)"></blockquote></div>';

describe("a reply in the reading pane", () => {
    it("folds its history behind a pill that opens and closes it", async () => {
        const { container } = render(
            <MessageBody html={REPLY} text="" remoteAllowed={false} trackerVendors={[]} />,
            { wrapper: MessagesWrapper }
        );
        await waitFor(() => expect(frameSource(container)).toContain("Thanks, see you then!"));
        expect(frameSource(container)).not.toContain("Shall we meet?");
        // Still sanitized: the trimmed copy went through the sanitizer.
        expect(frameSource(container)).not.toContain("onerror");

        const pill = screen.getByRole("button", { name: "Show trimmed content" });
        expect(pill.getAttribute("aria-expanded")).toBe("false");
        fireEvent.click(pill);
        await waitFor(() => expect(frameSource(container)).toContain("Shall we meet?"));
        expect(frameSource(container)).not.toContain("onerror");
        expect(screen.getByRole("button", { name: "Hide trimmed content" })).toBeTruthy();
    });

    it("draws a message that is only a quote whole, with no pill", async () => {
        const only =
            '<div class="gmail_quote"><div class="gmail_attr">On Mon, Ann wrote:</div><blockquote>Only this</blockquote></div>';
        const { container } = render(
            <MessageBody html={only} text="" remoteAllowed={false} trackerVendors={[]} />,
            { wrapper: MessagesWrapper }
        );
        await waitFor(() => expect(frameSource(container)).toContain("Only this"));
        expect(screen.queryByRole("button", { name: "Show trimmed content" })).toBeNull();
    });

    it("trims a plain-text message too", async () => {
        const { container } = render(
            <MessageBody
                html=""
                text={"Friday works.\n\nOn Mon, Ann wrote:\n> Shall we meet?"}
                remoteAllowed={false}
                trackerVendors={[]}
            />,
            { wrapper: MessagesWrapper }
        );
        await waitFor(() => expect(frameSource(container)).toContain("Friday works."));
        expect(frameSource(container)).not.toContain("Shall we meet?");
    });
});
