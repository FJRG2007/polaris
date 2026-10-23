// @vitest-environment jsdom

/**
 * Polar's approval card: the call's input painted by the shared JSON
 * highlighter, the target named as the server reads it, and "Always allow"
 * stored on the server before the call is approved - asked twice for a tool
 * that can destroy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { MessagesWrapper } = await import("../setup/i18n");
const { Confirmation } = await import("@/components/polar/elements/confirmation");

const calls: { tool: string; input: unknown; allow: boolean }[] = [];

beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: string }) => {
            calls.push(JSON.parse(init.body) as (typeof calls)[number]);
            return new Response(
                JSON.stringify({
                    target: { name: "Studio door", action: "unlatch" },
                    scope: "target"
                }),
                { status: 200 }
            );
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function card(destructive: boolean, onApprove = vi.fn()) {
    const view = render(
        <MessagesWrapper>
            <Confirmation
                state="approval-requested"
                approval={{ id: "a1" }}
                action="Operate a device"
                affects={[]}
                destructive={destructive}
                input={{ deviceId: "d1", action: "unlatch" }}
                tool="places_device_control"
                onApprove={onApprove}
                onReject={() => {}}
            />
        </MessagesWrapper>
    );
    return { ...view, onApprove };
}

describe("the approval card", () => {
    it("puts the warning and who it runs as on lines of their own, never run together", () => {
        card(true);
        const warning = screen.getByText("This can't be undone from here.");
        const runsAs = screen.getByText("Runs as you");
        // Each sentence is its own element in its own block-level row, so the
        // two can neither touch nor share a line.
        expect(warning.parentElement).not.toBe(runsAs.parentElement);
        for (const text of [warning, runsAs]) {
            const row = text.parentElement as HTMLElement;
            expect(row.tagName).toBe("P");
            expect(row.className.split(" ")).toContain("flex");
            expect(row.className).not.toContain("inline-flex");
        }
    });

    it("paints the input with the JSON highlighter", async () => {
        const { container } = card(false);
        await waitFor(() => expect(container.querySelector("[class^='hljs-']")).not.toBeNull());
        expect(container.textContent).toContain('"deviceId": "d1"');
    });

    it("names the target the server read, above the JSON", async () => {
        card(false);
        expect(await screen.findByText("Unlatch Studio door")).toBeTruthy();
        expect(calls[0]).toMatchObject({ tool: "places_device_control", allow: false });
    });

    it("stores Always allow, then approves", async () => {
        const { onApprove } = card(false);
        fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
        await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
        expect(calls.some((call) => call.allow)).toBe(true);
    });

    it("says plainly it will stop asking before a destructive tool is always allowed", async () => {
        const { onApprove } = card(true);
        await screen.findByText("Unlatch Studio door");
        fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
        expect(onApprove).not.toHaveBeenCalled();
        expect(screen.getByText(/do this to Studio door without asking again/)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Allow and run" }));
        await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    });
});

describe("the browser's site card", () => {
    function siteCard() {
        const onApprove = vi.fn();
        const onAlwaysSite = vi.fn();
        const onReject = vi.fn();
        render(
            <MessagesWrapper>
                <Confirmation
                    state="approval-requested"
                    approval={{ id: "a2" }}
                    action="Scrolling x.com"
                    affects={[]}
                    destructive={false}
                    input={{ action: "scroll", site: "x.com" }}
                    site="x.com"
                    onApprove={onApprove}
                    onAlwaysSite={onAlwaysSite}
                    onReject={onReject}
                />
            </MessagesWrapper>
        );
        return { onApprove, onAlwaysSite, onReject };
    }

    it("asks for the site: allow once, always for it, or not", () => {
        const { onApprove, onAlwaysSite, onReject } = siteCard();
        expect(screen.getByText("Polar wants to use x.com in your browser.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Always for x.com" }));
        expect(onAlwaysSite).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
        expect(onApprove).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "Not now" }));
        expect(onReject).toHaveBeenCalledTimes(1);
    });
});
