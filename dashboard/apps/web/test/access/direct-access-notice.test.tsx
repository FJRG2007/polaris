// @vitest-environment jsdom
/**
 * The firewall screen says which services answer round it, and closes them.
 *
 * Each service is named with the address it answers on. Closing asks first in a
 * dialog, marks the row as closing at once and puts it back if the close fails.
 * A port this screen cannot close says why instead of offering a button, and a
 * reader who may not close them sees the button disabled with the reason.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const WEB = "00000000-0000-7000-8000-0000000000a1";
const KEPT = "00000000-0000-7000-8000-0000000000a2";

let reachable: { applicationId: string; name: string; address: string; held: string | null }[] = [];
const getDirectAccessAction = vi.fn(async () => ({ reachable }));
const closeDirectAccessAction = vi.fn(
    async (_input: Record<string, unknown>): Promise<{ closed?: number; failed?: number; error?: string }> => ({
        closed: 1,
        failed: 0
    })
);
vi.mock("../../src/app/(app)/apps/firewall/actions", () => ({
    getDirectAccessAction,
    closeDirectAccessAction
}));

const { DirectAccessNotice } = await import("../../src/app/(app)/apps/firewall/direct-access-notice");

function show(canClose = true) {
    render(
        <MessagesWrapper>
            <DirectAccessNotice scopeType="project" scopeId="project-1" canClose={canClose} />
        </MessagesWrapper>
    );
}

beforeEach(() => {
    reachable = [
        { applicationId: WEB, name: "web", address: "203.0.113.7:21234", held: null },
        { applicationId: KEPT, name: "docs", address: "203.0.113.7:31234", held: "keptRelease" }
    ];
    getDirectAccessAction.mockClear();
    closeDirectAccessAction.mockClear();
});
afterEach(cleanup);

describe("the direct access warning", () => {
    it("draws nothing when every service is reached through the edge alone", async () => {
        reachable = [];
        show();
        await waitFor(() => expect(getDirectAccessAction).toHaveBeenCalled());
        expect(screen.queryByText("Reachable round the firewall")).toBeNull();
    });

    it("names each service and the address it answers on", async () => {
        show();
        expect(await screen.findByText("Reachable round the firewall")).toBeTruthy();
        expect(screen.getByText("web on 203.0.113.7:21234")).toBeTruthy();
        expect(screen.getByText("docs on 203.0.113.7:31234")).toBeTruthy();
        // A kept release is closed from the service, not from here.
        expect(screen.getAllByRole("button", { name: /Close the port of/ })).toHaveLength(1);
    });

    it("asks in a dialog, then marks the row closing", async () => {
        show();
        fireEvent.click(await screen.findByRole("button", { name: "Close the port of web" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Close this port?")).toBeTruthy();
        expect(closeDirectAccessAction).not.toHaveBeenCalled();
        fireEvent.click(within(dialog).getByRole("button", { name: "Close port" }));
        await waitFor(() =>
            expect(closeDirectAccessAction).toHaveBeenCalledWith({
                scopeType: "project",
                scopeId: "project-1",
                applicationId: WEB
            })
        );
        expect(await screen.findByText("Closing")).toBeTruthy();
    });

    it("puts the row back when the close fails", async () => {
        closeDirectAccessAction.mockResolvedValueOnce({ error: "Could not close the port." });
        show();
        fireEvent.click(await screen.findByRole("button", { name: "Close the port of web" }));
        fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close port" }));
        await waitFor(() => expect(closeDirectAccessAction).toHaveBeenCalled());
        expect(await screen.findByRole("button", { name: "Close the port of web" })).toBeTruthy();
        expect(screen.queryByText("Closing")).toBeNull();
    });

    it("disables the close with the reason for a reader who may not close them", async () => {
        show(false);
        const button = await screen.findByRole("button", { name: "Close the port of web" });
        expect(button.hasAttribute("disabled")).toBe(true);
        expect(screen.getAllByText("Only whoever runs this instance can close these.").length).toBeGreaterThan(0);
    });

    it("reads in Spanish from the catalog", async () => {
        const { withMessages } = await import("../setup/i18n");
        render(withMessages(<DirectAccessNotice scopeType="project" scopeId="project-1" canClose />, "es-ES"));
        expect(await screen.findByText("Accesibles sin el cortafuegos")).toBeTruthy();
        expect(screen.getByText("web en 203.0.113.7:21234")).toBeTruthy();
    });
});
