// @vitest-environment jsdom

/**
 * An identity's several emails and phones, and its street in parts.
 *
 * The main email or phone is Bitwarden's own field and the rest are custom
 * fields; an identity stored before the street had parts opens with its line
 * read into them where that is certain, and nothing is rewritten until saved.
 */

import * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import { emptyItem } from "@/app/(app)/vault/vault-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { contactProblem, IdentityContactList, withPrimary } from "@/app/(app)/vault/identity-contact-list";

vi.mock("@/app/(app)/vault/vault-session", () => ({
    useVaultSession: () => ({ vaults: [], vaultKeys: new Map() })
}));
vi.mock("@/app/(app)/vault/use-vault-collections", () => ({
    useVaultCollections: () => ({ collections: [] })
}));
vi.mock("@/app/(app)/vault/vault-actions", () => ({
    accountIdentityAction: vi.fn(async () => null)
}));
vi.mock("@/components/password-state", () => ({ PasswordState: () => null }));

const { ItemDialog } = await import("@/app/(app)/vault/item-dialog");

afterEach(cleanup);

describe("the rows of emails and phones", () => {
    it("calls an empty row unfinished, and a wrong one wrong", () => {
        expect(contactProblem("email", "")).toBeNull();
        expect(contactProblem("email", " Ada@Example.com ")).toBeNull();
        expect(contactProblem("email", "ada")).toBe("invalidEmail");
        expect(contactProblem("phone", "+34 600 000 000")).toBeNull();
        expect(contactProblem("phone", "nope")).toBe("invalidPhone");
    });

    it("moves the row made main to the top", () => {
        expect(withPrimary(["a", "b", "c"], 2)).toEqual(["c", "a", "b"]);
        expect(withPrimary(["a", "b"], 0)).toEqual(["a", "b"]);
    });

    it("adds, removes and promotes rows", () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <IdentityContactList kind="email" label="Email" values={["a@x.test"]} onChange={onChange} />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Add another email" }));
        expect(onChange).toHaveBeenLastCalledWith(["a@x.test", ""]);
        rerender(<IdentityContactList kind="email" label="Email" values={["a@x.test", "b@x.test"]} onChange={onChange} />);
        fireEvent.click(screen.getByRole("button", { name: "Set as primary" }));
        expect(onChange).toHaveBeenLastCalledWith(["b@x.test", "a@x.test"]);
        fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
        expect(onChange).toHaveBeenLastCalledWith(["b@x.test"]);
    });

    it("says when a row is not an email", () => {
        render(<IdentityContactList kind="email" label="Email" values={["nope"]} onChange={() => {}} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByRole("alert").textContent).toBe("That does not look like an email address.");
    });
});

describe("an identity opened in the editor", () => {
    function open(item: ReturnType<typeof emptyItem>, onSave = vi.fn(async () => null)) {
        render(
            <ItemDialog
                item={item}
                folders={[]}
                onClose={() => {}}
                onSave={onSave}
                onCreateFolder={async () => null}
            />,
            { wrapper: MessagesWrapper }
        );
        return onSave;
    }

    function stored() {
        const item = emptyItem(core.CIPHER_IDENTITY);
        item.id = "id1";
        item.name = "Home";
        item.identity = {
            ...item.identity,
            email: "a@x.test",
            address1: "Camino Huertas de la Manga N6",
            country: "ES"
        };
        item.fields = [{ name: "Email 2", value: "b@x.test", type: core.FIELD_TEXT }];
        return item;
    }

    it("reads an old street line into its parts and has nothing to save", () => {
        open(stored());
        expect((screen.getByLabelText("Street name") as HTMLInputElement).value).toBe("Huertas de la Manga");
        expect((screen.getByLabelText("Number") as HTMLInputElement).value).toBe("6");
        expect((screen.getByLabelText("Email 2") as HTMLInputElement).value).toBe("b@x.test");
        expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    });

    it("composes the line and stores the parts once one is changed", async () => {
        const onSave = open(stored());
        fireEvent.change(screen.getByLabelText("Number"), { target: { value: "8" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
        const saved = onSave.mock.calls[0]![0] as ReturnType<typeof emptyItem>;
        expect(saved.identity.address1).toBe("Camino Huertas de la Manga 8");
        expect(core.readAddress(saved.fields)).toMatchObject({ streetType: "Camino", houseNumber: "8" });
        expect(core.readContacts(saved.fields).emails).toEqual(["b@x.test"]);
    });
});
