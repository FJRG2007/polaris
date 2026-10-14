// @vitest-environment jsdom

/**
 * The fields dialog's money field: a new one starts in the reader's own
 * currency, the chosen code is what is sent, and an existing one shows its
 * currency as fixed instead of offering a picker.
 */

import { crmHost } from "./crm-host";
import type { DisplayPreferences } from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({ created: [] as unknown[] }));

vi.mock("@polaris-app/crm/src/actions/records", () => ({
    createFieldAction: async (input: {
        field: { label: string; kind: string; options: string[] };
    }) => {
        state.created.push(input);
        return { ok: true, field: { id: "f1", slot: "cNum1", ...input.field } };
    },
    updateFieldAction: async () => ({ ok: false, error: "unused" }),
    deleteFieldAction: async () => ({ ok: false, error: "unused" })
}));

import { FieldsDialog } from "@polaris-app/crm/src/screens/fields-dialog";

beforeEach(() => {
    state.created = [];
});

afterEach(cleanup);

const noop = () => undefined;

function newField(currency?: DisplayPreferences["currency"]) {
    const onCreated = vi.fn();
    render(
        <FieldsDialog
            object="opportunities"
            fields={[]}
            canDelete
            onCreated={onCreated}
            onChanged={noop}
            onClose={noop}
        />,
        { wrapper: crmHost(currency ? { currency } : {}) }
    );
    return onCreated;
}

async function chooseKind(name: string) {
    fireEvent.click(screen.getByRole("combobox", { name: "Type" }));
    fireEvent.click(await screen.findByRole("option", { name }));
}

describe("fields dialog, money field", () => {
    it("starts in the reader's currency and sends the code chosen instead", async () => {
        const onCreated = newField("USD");
        fireEvent.change(screen.getByPlaceholderText(/./), { target: { value: "Budget" } });
        await chooseKind("Amount");
        const picker = await screen.findByRole("combobox", { name: "Currency" });
        expect(picker.textContent).toContain("USD");
        fireEvent.click(picker);
        fireEvent.click(await screen.findByRole("option", { name: /^JPY - / }));
        expect(screen.getByRole("combobox", { name: "Currency" }).textContent).toContain("JPY");
        fireEvent.click(screen.getByRole("button", { name: "Add field" }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(state.created).toEqual([
            {
                object: "opportunities",
                field: { label: "Budget", kind: "money", options: ["JPY"] }
            }
        ]);
    });

    it("falls back to euros when the reader's currency is not one a field can hold", async () => {
        // A preference saved before the currency list it is checked against.
        newField("ZZZ" as unknown as DisplayPreferences["currency"]);
        await chooseKind("Amount");
        expect((await screen.findByRole("combobox", { name: "Currency" })).textContent).toContain(
            "EUR"
        );
    });

    it("shows an existing money field's currency as fixed, with no picker", async () => {
        render(
            <FieldsDialog
                object="opportunities"
                fields={[
                    { id: "f1", slot: "cNum1", label: "Budget", kind: "money", options: ["GBP"] }
                ]}
                canDelete
                onCreated={noop}
                onChanged={noop}
                onClose={noop}
            />,
            { wrapper: crmHost() }
        );
        fireEvent.click(screen.getByRole("button", { name: "Edit field" }));
        expect(screen.queryByRole("combobox", { name: "Currency" })).toBeNull();
        const fixed = screen.getByTitle("The currency cannot change once the field exists.");
        expect(fixed.textContent).toMatch(/^GBP - /);
    });
});

describe("fields dialog, relation field", () => {
    it("sends the kind it links to and that it holds several", async () => {
        const onCreated = newField();
        fireEvent.change(screen.getByPlaceholderText(/./), { target: { value: "Partners" } });
        await chooseKind("Linked records");
        fireEvent.click(await screen.findByRole("combobox", { name: "Links to" }));
        fireEvent.click(await screen.findByRole("option", { name: "Companies" }));
        fireEvent.click(screen.getByRole("combobox", { name: "Holds" }));
        fireEvent.click(await screen.findByRole("option", { name: "Several records" }));
        fireEvent.click(screen.getByRole("button", { name: "Add field" }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(state.created).toEqual([
            {
                object: "opportunities",
                field: { label: "Partners", kind: "relation", options: ["companies", "many"] }
            }
        ]);
    });

    it("starts linking to its own kind, one record at a time", async () => {
        newField();
        await chooseKind("Linked records");
        expect((await screen.findByRole("combobox", { name: "Links to" })).textContent).toContain(
            "Opportunities"
        );
        expect(screen.getByRole("combobox", { name: "Holds" }).textContent).toContain("One record");
    });

    it("shows an existing relation's target and size as fixed, with no pickers", async () => {
        render(
            <FieldsDialog
                object="opportunities"
                fields={[
                    {
                        id: "f1",
                        slot: "cRel1",
                        label: "Partners",
                        kind: "relation",
                        options: ["people", "many"]
                    }
                ]}
                canDelete
                onCreated={noop}
                onChanged={noop}
                onClose={noop}
            />,
            { wrapper: crmHost() }
        );
        fireEvent.click(screen.getByRole("button", { name: "Edit field" }));
        expect(screen.queryByRole("combobox", { name: "Links to" })).toBeNull();
        expect(screen.queryByRole("combobox", { name: "Holds" })).toBeNull();
        expect(
            screen.getByTitle("What it links to cannot change once the field exists.").textContent
        ).toBe("People");
        expect(
            screen.getByTitle("How many it holds cannot change once the field exists.").textContent
        ).toBe("Several records");
    });
});
