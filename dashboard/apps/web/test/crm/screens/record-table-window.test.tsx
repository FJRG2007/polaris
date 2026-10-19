// @vitest-environment jsdom
/**
 * A long list draws only the rows in sight: thousands of loaded records keep a
 * page or two of rows in the document, while a short list draws every row.
 */

import { crmHost } from "./crm-host";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { RecordTable } from "@polaris-app/crm/src/screens/record-table";

afterEach(cleanup);

/* jsdom lays nothing out, so every box is given a screen's size for the
 * window to be measured against. */
const measure = HTMLElement.prototype.getBoundingClientRect;
beforeAll(() => {
    HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 800);
});
afterAll(() => {
    HTMLElement.prototype.getBoundingClientRect = measure;
});

const records = (count: number) =>
    Array.from({ length: count }, (_, at) => ({
        id: `00000000-0000-7000-8000-${String(at).padStart(12, "0")}`,
        values: { name: `Example Co ${at}` }
    })) as never[];

function drawn(count: number): number {
    const noop = () => undefined;
    const { container } = render(
        <RecordTable
            object="companies"
            columns={[{ key: "name", width: 240 }] as never}
            sorts={[]}
            rows={records(count)}
            totals={[]}
            people={[]}
            canEdit={false}
            canShape={false}
            defaultCurrency="EUR"
            selected={[]}
            onSelect={noop}
            onEdit={noop}
            onSort={noop}
            onColumns={noop}
            onAggregate={noop}
            draft={null}
            hasMore={false}
            loadingMore={false}
            onLoadMore={noop}
        />,
        { wrapper: crmHost() }
    );
    return container.querySelectorAll("tbody tr[aria-selected]").length;
}

describe("a long list", () => {
    it("draws every row of a short list", () => {
        expect(drawn(20)).toBe(20);
    });

    it("draws only a window of a list of five thousand rows", () => {
        const rows = drawn(5_000);
        expect(rows).toBeGreaterThan(0);
        expect(rows).toBeLessThan(100);
    });
});
