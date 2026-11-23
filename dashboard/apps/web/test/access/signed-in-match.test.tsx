// @vitest-environment jsdom
/**
 * The sign-in form, typing an identifier that names an account this browser is
 * already signed in to: it says so with that account, offers the switch, and
 * holds the sign-in back - all without asking the server anything.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const switchAccountAction = vi.fn(async (_id: string) => ({}));
const leaveAccount = vi.fn(async (_target: string) => undefined);

vi.mock("@/app/device-account-actions", () => ({ switchAccountAction }));
vi.mock("@/lib/account-switch", () => ({ leaveAccount }));

const { MessagesWrapper } = await import("../setup/i18n");
const { SignedInNotice, useSignedInMatch } = await import("@/app/oauth/login/signed-in-match");
type SignedInHere = import("@/app/oauth/login/signed-in-match").SignedInHere;

const ANA: SignedInHere = {
    id: "00000000-0000-4000-8000-00000000000a",
    userId: "user-ana",
    name: "Ana Fixture",
    email: "ana@fixture.test",
    image: null,
    active: false,
    username: "ana_f",
    phone: "+34600111222"
};
const BEN: SignedInHere = { ...ANA, id: "b", userId: "user-ben", name: "Ben", email: "ben@fixture.test", username: null, phone: null, active: true };

function Probe({ identifier }: { identifier: string }) {
    const match = useSignedInMatch(identifier, [ANA, BEN], "ES");
    return <span data-testid="match">{match?.userId ?? "none"}</span>;
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe("useSignedInMatch", () => {
    it.each([
        ["ANA@fixture.test", "user-ana"],
        ["Ana_F", "user-ana"],
        ["600 11 12 22", "user-ana"],
        ["ben@fixture.test", "user-ben"],
        ["cai@fixture.test", "none"]
    ])("settles %s on %s once typing stops", async (typed, expected) => {
        vi.useFakeTimers();
        render(<Probe identifier={typed} />);
        expect(screen.getByTestId("match").textContent).toBe("none");
        await act(async () => {
            vi.advanceTimersByTime(200);
        });
        expect(screen.getByTestId("match").textContent).toBe(expected);
    });
});

describe("SignedInNotice", () => {
    it("names the account and switches to it", async () => {
        render(<SignedInNotice account={ANA} back="/home" />, { wrapper: MessagesWrapper });
        expect(screen.getByText("Ana Fixture")).toBeTruthy();
        expect(screen.getByText("Already signed in on this browser.")).toBeTruthy();
        await act(async () => {
            screen.getByRole("button", { name: "Switch to this account" }).click();
        });
        expect(switchAccountAction).toHaveBeenCalledWith(ANA.id);
        expect(leaveAccount).toHaveBeenCalledWith("/home");
    });

    it("offers the way back for the account already in use, without switching", () => {
        render(<SignedInNotice account={BEN} back="/home" />, { wrapper: MessagesWrapper });
        expect(screen.getByText("You are using this account right now.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Back to this account" })).toBeTruthy();
        expect(switchAccountAction).not.toHaveBeenCalled();
    });
});
