// @vitest-environment jsdom
/**
 * Scrolling a list asks for the page after the one the server last sent,
 * whatever has been edited on screen since: a row whose sort value changed in
 * place does not move where the next page starts, and a list the server says
 * has ended is not asked again.
 */

import { crmHost } from "./crm-host";
import type { CrmRecord } from "@polaris-app/crm/src/model/objects";
import { useRecords } from "@polaris-app/crm/src/screens/use-records";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const pages = vi.hoisted(() => ({
    answers: [] as unknown[],
    asked: [] as Record<string, unknown>[]
}));

vi.mock("@polaris-app/crm/src/actions/records", () => ({
    listRecordsAction: async (input: Record<string, unknown>) => {
        pages.asked.push(input);
        return (
            pages.answers.shift() ?? { ok: true, records: [], total: null, next: null, more: false }
        );
    }
}));

afterEach(cleanup);
beforeEach(() => {
    pages.answers = [];
    pages.asked = [];
});

const record = (at: number): CrmRecord => ({
    id: `00000000-0000-7000-8000-${String(at).padStart(12, "0")}`,
    position: 0,
    deletedAt: null,
    values: { name: `Example Co ${at}` }
});

const range = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, at) => record(from + at));

function listOf(search: string) {
    return renderHook(
        () => useRecords("companies", { search, sorts: [], filter: { all: [] } as never }),
        { wrapper: crmHost() }
    );
}

describe("paging a list", () => {
    it("starts the next page where the server said, after an edit on screen", async () => {
        pages.answers.push(
            { ok: true, records: range(0, 50), total: 120, next: "first-page-end", more: true },
            { ok: true, records: range(50, 100), total: null, next: "second-page-end", more: true }
        );
        const list = listOf("edited");
        await waitFor(() => expect(list.result.current.rows).toHaveLength(50));
        act(() => list.result.current.patch([{ id: record(49).id, values: { name: "Renamed" } }]));
        act(() => list.result.current.loadMore());
        await waitFor(() => expect(list.result.current.rows).toHaveLength(100));
        expect(pages.asked[1]).toMatchObject({ after: "first-page-end", offset: 50 });
        expect(list.result.current.total).toBe(120);
        expect(list.result.current.hasMore).toBe(true);
        act(() => list.result.current.loadMore());
        await waitFor(() => expect(pages.asked).toHaveLength(3));
        expect(pages.asked[2]).toMatchObject({ after: "second-page-end" });
    });

    it("stops asking once the server sent the last page", async () => {
        pages.answers.push(
            { ok: true, records: range(0, 50), total: 60, next: "first-page-end", more: true },
            { ok: true, records: [], total: null, next: null, more: false }
        );
        const list = listOf("ended");
        await waitFor(() => expect(list.result.current.rows).toHaveLength(50));
        act(() => list.result.current.loadMore());
        await waitFor(() => expect(list.result.current.hasMore).toBe(false));
        act(() => list.result.current.loadMore());
        expect(pages.asked).toHaveLength(2);
    });
});
