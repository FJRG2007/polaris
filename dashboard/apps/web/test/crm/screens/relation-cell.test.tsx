// @vitest-environment jsdom

/**
 * A relation somebody added, in a cell: each linked record is a chip that
 * opens it, a field that holds one swaps it in a single pick, and a field that
 * holds several toggles records and saves them once, as the menu closes.
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
