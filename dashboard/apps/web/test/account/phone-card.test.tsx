// @vitest-environment jsdom

/**
 * The phone numbers on the account, listed the way the email addresses are:
 * each with its Primary and Confirmed marks, an "Add phone number" header button
 * opening a dialog with the country picker that asks the password next, and a code box that only opens
 * under the number the code went to, labelled with that number.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const actions = vi.hoisted(() => ({
    add: vi.fn(async (_input: unknown): Promise<{ error?: string; id?: string }> => ({ id: "new-id" })),
    send: vi.fn(async (_id: unknown): Promise<{ error?: string }> => ({})),
    verify: vi.fn(async (_input: unknown): Promise<{ error?: string }> => ({}))
}));
vi.mock("@/app/(app)/account/security/two-factor-actions", () => ({
    addPhoneAction: actions.add,
    removePhoneAction: vi.fn(async () => ({})),
    makePhonePrimaryAction: vi.fn(async () => ({})),
    sendPhoneCodeAction: actions.send,
    verifyPhoneAction: actions.verify
}));

const { PhoneCard, phoneToAdd } = await import("@/app/(app)/account/phone-card");

afterEach(() => {
    cleanup();
    for (const action of Object.values(actions)) action.mockClear();
});

// Fixture numbers only (Spain's 600 mobile range).
const PRIMARY = { id: "p1", phone: "+34600111222", verified: true, primary: true };
const SECOND = { id: "p2", phone: "+34600111333", verified: false, primary: false };

function renderCard(phones: (typeof PRIMARY)[], enforced = false) {
    return render(
        <MessagesWrapper>
            <PhoneCard phones={phones} canSend enforced={enforced} />
        </MessagesWrapper>
    );
}

const openAdd = () => fireEvent.click(screen.getByRole("button", { name: "Add phone number" }));
const addField = () => screen.getByLabelText(/^Phone number/) as HTMLInputElement;
const addButton = () => screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;

describe("PhoneCard", () => {
    it("lists every number with its marks, and no code box until a code is sent", () => {
        renderCard([PRIMARY, SECOND]);
        expect(screen.getByText("Primary")).toBeTruthy();
        expect(screen.getByText("Confirmed")).toBeTruthy();
        expect(screen.getByText("Unconfirmed")).toBeTruthy();
        expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(2);
        expect(screen.queryByLabelText(/^Code sent to/)).toBeNull();
    });

    it("adds through one header button and a dialog, never an inline field", async () => {
        renderCard([PRIMARY]);
        expect(screen.queryByLabelText(/^Phone number/)).toBeNull();
        openAdd();
        expect(await screen.findByRole("dialog")).toBeTruthy();
        expect(addField()).toBeTruthy();
    });

    it("keeps Continue off for a number already on the account, even regrouped", () => {
        renderCard([PRIMARY]);
        openAdd();
        expect(addButton().getAttribute("aria-disabled")).toBe("true");
        fireEvent.change(addField(), { target: { value: "+34 600 111 222" } });
        expect(addButton().getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText("That number is already on your account.")).toBeTruthy();
        fireEvent.change(addField(), { target: { value: "+34 600 111 444" } });
        expect(addButton().getAttribute("aria-disabled")).toBeNull();
    });

    it("keeps the header button off once the account holds the most numbers", () => {
        renderCard([1, 2, 3, 4, 5].map((n) => ({ ...SECOND, id: `p${n}`, phone: `+3460011100${n}` })));
        expect((screen.getByRole("button", { name: "Add phone number" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("asks the password after Add, then sends a code and labels the box with the number", async () => {
        renderCard([PRIMARY]);
        openAdd();
        fireEvent.change(addField(), { target: { value: "+34 600 111 444" } });
        fireEvent.click(addButton());
        const password = await screen.findByLabelText("Current password");
        fireEvent.change(password, { target: { value: "fixture-password" } });
        fireEvent.submit(password.closest("form")!);
        await waitFor(() =>
            expect(actions.add).toHaveBeenCalledWith({ phone: "+34600111444", password: "fixture-password" })
        );
        await waitFor(() => expect(actions.send).toHaveBeenCalledWith("new-id"));
    });

    it("opens Add empty again after a number was typed and cancelled (BUG-0078)", async () => {
        renderCard([PRIMARY]);
        openAdd();
        fireEvent.change(addField(), { target: { value: "+34 600 111 444" } });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        openAdd();
        expect(addField().value).toBe("");
        expect(addButton().getAttribute("aria-disabled")).toBe("true");
    });

    it("keeps the typed number across the password step, and asks for the password empty", async () => {
        renderCard([PRIMARY]);
        openAdd();
        fireEvent.change(addField(), { target: { value: "+34 600 111 444" } });
        fireEvent.click(addButton());
        const password = await screen.findByLabelText("Current password");
        fireEvent.change(password, { target: { value: "fixture-password" } });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        openAdd();
        expect(addField().value).toBe("");
        fireEvent.change(addField(), { target: { value: "+34 600 111 555" } });
        fireEvent.click(addButton());
        expect(((await screen.findByLabelText("Current password")) as HTMLInputElement).value).toBe("");
        fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "fixture-password" } });
        fireEvent.submit(screen.getByLabelText("Current password").closest("form")!);
        await waitFor(() =>
            expect(actions.add).toHaveBeenCalledWith({ phone: "+34600111555", password: "fixture-password" })
        );
    });

    it("opens the code box under the number Confirm was pressed for, and sends its id", async () => {
        renderCard([PRIMARY, SECOND]);
        fireEvent.click(screen.getByRole("button", { name: /^Confirm \+34/ }));
        const box = (await screen.findByLabelText(/^Code sent to \+34/)) as HTMLInputElement;
        expect(actions.send).toHaveBeenCalledWith("p2");
        expect(document.activeElement).toBe(box);
        fireEvent.change(box, { target: { value: "123456" } });
        await waitFor(() => expect(actions.verify).toHaveBeenCalledWith({ id: "p2", code: "123456" }));
    });

    it("offers a new code for a confirmed number another account also holds", async () => {
        renderCard([{ ...PRIMARY, reconfirm: true } as typeof PRIMARY]);
        expect(screen.getByText("Confirm it again to sign in with it.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: /^Confirm \+34/ }));
        expect(await screen.findByLabelText(/^Code sent to \+34/)).toBeTruthy();
        expect(actions.send).toHaveBeenCalledWith("p1");
    });

    it("works out the number to add against every number held", () => {
        expect(phoneToAdd("+34600111222", [PRIMARY.phone])).toBeNull();
        expect(phoneToAdd("+34600111999", [PRIMARY.phone])).toBe("+34600111999");
        expect(phoneToAdd("6001", [])).toBeNull();
    });
});
