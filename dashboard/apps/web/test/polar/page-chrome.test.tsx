// @vitest-environment jsdom
/**
 * The header around Polar's own page: the "Ask Polar" button is not offered
 * there, because it would open a second copy of the chat on screen.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let pathname = "/tasks";
vi.mock("next/navigation", () => ({
    usePathname: () => pathname,
    useRouter: () => ({ push: () => undefined })
}));

afterEach(() => {
    cleanup();
    pathname = "/tasks";
});

const { PolarProvider, PolarToggle, onPolarPage } = await import(
    "@/components/polar/polar-panel"
);

function header(allowed = true) {
    return render(
        <PolarProvider allowed={allowed}>
            <PolarToggle />
        </PolarProvider>,
        { wrapper: MessagesWrapper }
    );
}

describe("the header's Polar button", () => {
    it("is offered on every other page", () => {
        header();
        expect(screen.getByRole("button", { pressed: false })).toBeTruthy();
    });

    it("is not offered on Polar's own page", () => {
        pathname = "/polar";
        header();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("is not offered to somebody Polar is not open to", () => {
        header(false);
        expect(screen.queryByRole("button")).toBeNull();
    });
});

describe("onPolarPage", () => {
    it("matches the page and below it, and nothing that only starts the same", () => {
        expect(onPolarPage("/polar")).toBe(true);
        expect(onPolarPage("/polar/anything")).toBe(true);
        expect(onPolarPage("/polaris-from")).toBe(false);
        expect(onPolarPage("/account/polar-tools")).toBe(false);
        expect(onPolarPage("/tasks")).toBe(false);
    });
});
