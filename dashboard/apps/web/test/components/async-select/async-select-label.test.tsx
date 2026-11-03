// @vitest-environment jsdom
import { AsyncSelect } from "@polaris/ui";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

interface Row {
    readonly id: string;
    readonly name: string;
}

const common = {
    itemValue: (row: Row) => row.id,
    itemLabel: (row: Row) => row.name,
    onValueChange: () => undefined,
    "aria-label": "Server"
};

describe("AsyncSelect", () => {
    it("names the chosen value from a known label without reading the list", () => {
        const load = vi.fn();
        render(
            <AsyncSelect<Row>
                {...common}
                load={load}
                cacheKey="label-known"
                value="host-1"
                selectedLabel="edge-01"
            />
        );
        expect(screen.getByRole("button", { name: "Server" }).textContent).toContain("edge-01");
        expect(load).not.toHaveBeenCalled();
    });

    it("resolves the chosen value by id when nothing on screen names it", async () => {
        const load = vi.fn();
        const resolve = vi.fn(async (id: string) => ({ id, name: "db-02" }));
        render(
            <AsyncSelect<Row>
                {...common}
                load={load}
                cacheKey="label-resolved"
                value="host-2"
                resolve={resolve}
            />
        );
        expect(await screen.findByText("db-02")).toBeTruthy();
        expect(resolve).toHaveBeenCalledWith("host-2");
        expect(load).not.toHaveBeenCalled();
    });
});
