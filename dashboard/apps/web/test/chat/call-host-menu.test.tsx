// @vitest-environment jsdom

/**
 * The host's right-click on somebody in a meeting.
 *
 * Handing the room over and showing somebody out used to be a list under the
 * call, a row per person, taking the room's height for something done once. It
 * is on the person now, where every other decision about them already is.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/chat/meeting-actions", () => ({}));

const { PersonMenu } = await import("@/app/(app)/chat/call-menus");

afterEach(cleanup);

function open(hosting?: { guest: boolean; onMakeHost: () => void; onRemove: () => void }) {
    render(
        <PersonMenu name="Ana" volumeKey="ana" hosting={hosting}>
            <button type="button">Ana tile</button>
        </PersonMenu>,
        { wrapper: MessagesWrapper }
    );
    fireEvent.contextMenu(screen.getByText("Ana tile"));
}

describe("the host's menu on a person", () => {
    it("hands the room over and shows somebody out", () => {
        const done: string[] = [];
        open({
            guest: false,
            onMakeHost: () => done.push("host"),
            onRemove: () => done.push("remove")
        });
        fireEvent.click(screen.getByText("Make Ana the host"));
        fireEvent.contextMenu(screen.getByText("Ana tile"));
        fireEvent.click(screen.getByText("Remove Ana"));
        expect(done).toEqual(["host", "remove"]);
    });

    it("never hands the room to a guest, and says why", () => {
        const done: string[] = [];
        open({ guest: true, onMakeHost: () => done.push("host"), onRemove: () => undefined });
        const item = screen.getByText("Make Ana the host").closest("[role=menuitem]");
        expect(item?.getAttribute("data-disabled")).not.toBeNull();
        expect(screen.getByText("Only somebody with a Polaris account can host")).toBeTruthy();
    });

    it("offers nothing of the kind to anybody who is not hosting", () => {
        open();
        expect(screen.queryByText("Make Ana the host")).toBeNull();
        expect(screen.queryByText("Remove Ana")).toBeNull();
    });
});
