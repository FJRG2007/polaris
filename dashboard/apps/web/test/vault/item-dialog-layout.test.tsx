// @vitest-environment jsdom

/**
 * The item editor's custom-field row, and the email box beside the username.
 *
 * The row used to put a full-width name box and a `flex-1` value box side by
 * side, so the name kept its whole width and the value was a sliver. jsdom has
 * no layout, so what is pinned is the shape that prevents it: the row stacks
 * until there is room, each half may shrink, and the buttons never do.
 */

import * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import { emptyItem } from "@/app/(app)/vault/vault-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/vault/vault-session", () => ({
    useVaultSession: () => ({ vaults: [], vaultKeys: new Map() })
}));
vi.mock("@/app/(app)/vault/use-vault-collections", () => ({
    useVaultCollections: () => ({ collections: [] })
}));
vi.mock("@/app/(app)/vault/vault-actions", () => ({
    accountIdentityAction: vi.fn(async () => null)
}));
// Strength and breach state ask the network; not what this is about.
vi.mock("@/components/password-state", () => ({ PasswordState: () => null }));

const { ItemDialog } = await import("@/app/(app)/vault/item-dialog");

afterEach(cleanup);

function open(item: ReturnType<typeof emptyItem>) {
    return render(
        <ItemDialog
            item={item}
            folders={[]}
            onClose={() => {}}
            onSave={async () => null}
            onCreateFolder={async () => null}
        />,
        { wrapper: MessagesWrapper }
    );
}

describe("a custom field row", () => {
    it("stacks when narrow and lets both boxes shrink", () => {
        const item = emptyItem(core.CIPHER_LOGIN);
        item.id = "i1";
        item.fields = [
            { name: "Region", value: "eu-west", type: core.FIELD_HIDDEN },
            { name: core.EMAIL_FIELD, value: "ada@example.com", type: core.FIELD_TEXT }
        ];
        open(item);

        // The email is a box of its own, not a row here.
        const rows = document.querySelectorAll("[data-custom-field]");
        expect(rows).toHaveLength(1);
        const row = rows[0] as HTMLElement;
        expect(row.className).toContain("flex-col");
        expect(row.className).toContain("sm:flex-row");

        const name = screen.getByDisplayValue("Region");
        expect(name.className).toContain("min-w-0");
        expect(name.className).toContain("sm:flex-1");

        const value = screen.getByDisplayValue("eu-west");
        // The value's own wrapper grows and may shrink below its content.
        const valueBox = value.closest(".flex-1") as HTMLElement;
        expect(valueBox.className).toContain("min-w-0");
        expect(valueBox.parentElement?.className).toContain("min-w-0");

        for (const button of row.querySelectorAll("button[aria-label]")) {
            if (button.closest(".relative")) continue; // the input's own eye
            expect(button.className).toContain("shrink-0");
        }
    });

    it("shows the email apart from the username", () => {
        const item = emptyItem(core.CIPHER_LOGIN);
        item.id = "i2";
        item.login.username = "ada_l";
        item.fields = [{ name: core.EMAIL_FIELD, value: "ada@example.com", type: core.FIELD_TEXT }];
        open(item);

        expect(screen.getByDisplayValue("ada_l")).toBeTruthy();
        const email = screen.getByDisplayValue("ada@example.com") as HTMLInputElement;
        expect(email.type).toBe("email");
    });

    it("opens an API key as its own kind, with its parts in boxes", () => {
        const item = emptyItem(core.CIPHER_SECURE_NOTE);
        item.id = "i3";
        item.fields = core.writeApiKey([], { key: "pk_1", secret: "sk_1", endpoint: "" });
        open(item);

        expect(screen.getByDisplayValue("pk_1")).toBeTruthy();
        expect((screen.getByDisplayValue("sk_1") as HTMLInputElement).type).toBe("password");
        expect(document.querySelectorAll("[data-custom-field]")).toHaveLength(0);
    });
});
