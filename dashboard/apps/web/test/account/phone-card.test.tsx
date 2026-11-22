// @vitest-environment jsdom

/**
 * The account's phone number is edited where it is shown: the field sits on the
 * card with its country picker, holds the number already on the account, and
 * Save only lights up for a whole number that is not the one already there.
 * The password is asked once Save is pressed, and a refused save puts the old
 * number back.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const actions = vi.hoisted(() => ({
    setPhone: vi.fn(async (_input: unknown): Promise<{ error?: string }> => ({}))
}));
vi.mock("@/app/(app)/account/security/two-factor-actions", () => ({
    setPhoneAction: actions.setPhone,
    removePhoneAction: vi.fn(async () => ({})),
    sendPhoneCodeAction: vi.fn(async () => ({})),
    verifyPhoneAction: vi.fn(async () => ({}))
}));

const { PhoneCard, phoneDraftToSave } = await import("@/app/(app)/account/phone-card");

afterEach(() => {
    cleanup();
    actions.setPhone.mockClear();
});

// Fixture numbers only (Spain's 600 mobile range).
const STORED = "+34600111222";

function renderCard(phone: { phone: string; verified: boolean } | null) {
    return render(
        <MessagesWrapper>
            <PhoneCard phone={phone} canSend />
        </MessagesWrapper>
    );
}

const field = () => document.getElementById("account-phone") as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

describe("PhoneCard", () => {
    it("shows the number field and its country inline, holding the current number", () => {
        renderCard({ phone: STORED, verified: false });
        expect(field().value).toBe("600 11 12 22");
        expect(document.querySelector("[data-flag='es']")).not.toBeNull();
        expect(screen.getByText("Unconfirmed")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Send code" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    });

    it("keeps Save off while the number is unchanged, regrouped or incomplete", () => {
        renderCard({ phone: STORED, verified: true });
        expect(save().disabled).toBe(true);
        fireEvent.change(field(), { target: { value: "600111222" } });
        expect(save().disabled).toBe(true);
        fireEvent.change(field(), { target: { value: "6001" } });
        expect(save().disabled).toBe(true);
        fireEvent.change(field(), { target: { value: "600111333" } });
        expect(save().disabled).toBe(false);
    });

    it("asks for the password only after Save, and rolls back a refused save", async () => {
        actions.setPhone.mockResolvedValueOnce({ error: "Wrong password." });
        renderCard({ phone: STORED, verified: true });
        expect(screen.queryByLabelText("Current password")).toBeNull();
        fireEvent.change(field(), { target: { value: "600111333" } });
        fireEvent.click(save());
        const password = await screen.findByLabelText("Current password");
        fireEvent.change(password, { target: { value: "fixture-password" } });
        fireEvent.submit(password.closest("form")!);
        await waitFor(() =>
            expect(actions.setPhone).toHaveBeenCalledWith({ phone: "+34600111333", password: "fixture-password" })
        );
        expect(await screen.findByText("Wrong password.")).toBeTruthy();
        // The account's own number and status are back.
        expect(screen.getByText("Confirmed")).toBeTruthy();
    });
});

describe("phoneDraftToSave", () => {
    it("is the number to save only when it is whole and new", () => {
        expect(phoneDraftToSave("", "")).toBeNull();
        expect(phoneDraftToSave("+346001", "")).toBeNull();
        expect(phoneDraftToSave(STORED, STORED)).toBeNull();
        expect(phoneDraftToSave(STORED, "")).toBe(STORED);
        expect(phoneDraftToSave("+34600111333", STORED)).toBe("+34600111333");
    });
});
