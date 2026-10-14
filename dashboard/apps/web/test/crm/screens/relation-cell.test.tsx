// @vitest-environment jsdom

/**
 * A relation somebody added, in a cell: each linked record is a chip that
 * opens it, a field that holds one swaps it in a single pick, and a field that
 * holds several toggles records and saves them once, as the menu closes. The
 * filter panel finds records of its target by name and keeps the ones chosen.
 */

import { crmHost } from "./crm-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { customDef } from "@polaris-app/crm/src/model/fields";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

vi.mock("@polaris-app/crm/src/actions/records", () => ({
    searchRefsAction: async () => ({
        ok: true,
        refs: [
            { id: "00000000-0000-4000-8000-00000000000a", name: "Example One" },
            { id: "00000000-0000-4000-8000-00000000000b", name: "Example Two" }
        ]
    })
}));

import { RefChips } from "@polaris-app/crm/src/screens/cell-display";
import { CellPicker } from "@polaris-app/crm/src/screens/cell-picker";
import { FilterButton } from "@polaris-app/crm/src/screens/filter-panel";
import { CustomFieldsProvider } from "@polaris-app/crm/src/screens/custom-fields";

const field = (many: boolean) =>
    customDef({
        id: "f1",
        slot: "cRel1",
        label: "Partners",
        kind: "relation",
        options: ["companies", many ? "many" : "one"]
    });

afterEach(cleanup);

describe("a relation cell", () => {
    it("draws each linked record as a link to its page", () => {
        render(
            <RefChips
                target="companies"
                value={[
                    { id: A, name: "Example One" },
                    { id: B, name: "Example Two" }
                ]}
            />,
            { wrapper: crmHost() }
        );
        const links = screen.getAllByRole("link");
        expect(links.map((link) => link.getAttribute("href"))).toEqual([
            `/crm/companies/${A}`,
            `/crm/companies/${B}`
        ]);
        expect(links[1]!.textContent).toContain("Example Two");
    });

    it("swaps the one record a single link holds in one pick", async () => {
        const onPick = vi.fn();
        render(
            <CellPicker
                object="people"
                field={field(false)}
                value={[{ id: A, name: "Example One" }]}
                people={[]}
                onPick={onPick}
                onClose={vi.fn()}
            />,
            { wrapper: crmHost() }
        );
        fireEvent.click(await screen.findByRole("menuitem", { name: /Example Two/ }));
        expect(onPick).toHaveBeenCalledWith([B], [{ id: B, name: "Example Two" }]);
    });

    it("toggles several and saves them once, when the menu closes", async () => {
        const onPick = vi.fn();
        render(
            <CellPicker
                object="people"
                field={field(true)}
                value={[{ id: A, name: "Example One" }]}
                people={[]}
                onPick={onPick}
                onClose={vi.fn()}
            />,
            { wrapper: crmHost() }
        );
        fireEvent.click(await screen.findByRole("menuitem", { name: /Example Two/ }));
        expect(onPick).not.toHaveBeenCalled();
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        await waitFor(() =>
            expect(onPick).toHaveBeenCalledWith(
                [A, B],
                [
                    { id: A, name: "Example One" },
                    { id: B, name: "Example Two" }
                ]
            )
        );
    });

    it("closes without saving when the same records are left", async () => {
        const onPick = vi.fn();
        const onClose = vi.fn();
        render(
            <CellPicker
                object="people"
                field={field(true)}
                value={[{ id: A, name: "Example One" }]}
                people={[]}
                onPick={onPick}
                onClose={onClose}
            />,
            { wrapper: crmHost() }
        );
        await screen.findByRole("menuitem", { name: /Example Two/ });
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(onPick).not.toHaveBeenCalled();
    });
});

describe("filtering on a relation", () => {
    it("chooses records of its target, found by name, and takes one back out", async () => {
        const onChange = vi.fn();
        const filter = {
            conjunction: "and" as const,
            rules: [{ id: "r1", key: "cRel1", operator: "isAnyOf" as const, value: null }]
        };
        const { rerender } = render(
            <CustomFieldsProvider value={[field(true)]}>
                <FilterButton object="people" filter={filter} people={[]} onChange={onChange} />
            </CustomFieldsProvider>,
            { wrapper: crmHost() }
        );
        fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
        fireEvent.keyDown(await screen.findByRole("button", { name: "Value" }), { key: "Enter" });
        fireEvent.click(await screen.findByRole("menuitem", { name: /Example Two/ }));
        expect(onChange).toHaveBeenLastCalledWith({
            ...filter,
            rules: [{ ...filter.rules[0], value: [{ id: B, name: "Example Two" }] }]
        });

        const chosen = {
            ...filter,
            rules: [{ ...filter.rules[0]!, value: [{ id: B, name: "Example Two" }] }]
        };
        rerender(
            <CustomFieldsProvider value={[field(true)]}>
                <FilterButton object="people" filter={chosen} people={[]} onChange={onChange} />
            </CustomFieldsProvider>
        );
        // The open menu hides the rest of the dialog from assistive tech.
        expect(screen.getByRole("button", { name: "Value", hidden: true }).textContent).toContain(
            "Example Two"
        );
        fireEvent.click(await screen.findByRole("menuitem", { name: /Example Two/ }));
        expect(onChange).toHaveBeenLastCalledWith({
            ...filter,
            rules: [{ ...filter.rules[0], value: null }]
        });
    });
});
