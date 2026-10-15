// @vitest-environment jsdom

/**
 * A folder that would not open leaves a way out on the panel itself: up one
 * folder, back to wherever the reader came from, and - for a server enrolled
 * without root - the sentence that says so and the server's page.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListingFailure } from "@/app/(app)/drive/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const back = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ back, push: vi.fn(), prefetch: vi.fn() }) }));

const { ListingError } = await import("@/app/(app)/drive/listing-error");

afterEach(() => {
    cleanup();
    back.mockReset();
});

const refused = (extra: Partial<ListingFailure> = {}): ListingFailure => ({
    reason: "You do not have permission to open this folder.",
    hint: null,
    detail: null,
    retryable: false,
    ...extra
});

function panel(error: ListingFailure, upHref: string | null, serverHref: string | null = null) {
    return (
        <MessagesWrapper>
            <ListingError error={error} onRetry={() => undefined} upHref={upHref} serverHref={serverHref} />
        </MessagesWrapper>
    );
}

describe("a folder that would not open", () => {
    it("says why and offers the folder above and the way back", () => {
        render(panel(refused(), "/drive?c=host%3Ah1&p=var"));
        expect(screen.getByRole("alert").textContent).toContain("permission");
        expect(screen.getByRole("link", { name: "Up one folder" }).getAttribute("href")).toBe(
            "/drive?c=host%3Ah1&p=var"
        );
        fireEvent.click(screen.getByRole("button", { name: "Go back" }));
        expect(back).toHaveBeenCalledOnce();
    });

    it("offers no retry for a refusal that would answer the same", () => {
        render(panel(refused(), null));
        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
        expect(screen.queryByRole("link", { name: "Up one folder" })).toBeNull();
    });

    it("names the missing root access and links the server", () => {
        render(panel(refused({ noRoot: true }), null, "/apps/servers/h1"));
        expect(screen.getByRole("alert").textContent).toContain("without root access");
        expect(screen.getByRole("link", { name: "Open server" }).getAttribute("href")).toBe(
            "/apps/servers/h1"
        );
    });

    it("folds the device's own words away", () => {
        render(panel(refused({ detail: "EACCES: /root" }), null));
        expect(screen.getByText("Technical details")).toBeTruthy();
        expect(screen.getByText("EACCES: /root")).toBeTruthy();
    });
});
