// @vitest-environment jsdom

/**
 * What the record editor does when somebody acts on a record.
 *
 * - **A delete asks first.** The trash button opens the confirmation, naming the
 *   record by type, name and content, and nothing is sent until it is confirmed.
 * - **A write is shown before it is answered.** A confirmed delete takes the row
 *   off at once; a refusal puts it back and says why. An add that is refused
 *   takes its row away again and reopens the form with the reason.
 *
 * Driven through the real component in jsdom, with the server actions replaced:
 * what is under test is the order of those steps, which markup alone cannot show.
 */

import { emptyDraft } from "@/lib/dns/record-schema";
import { writeSnapshot } from "@/lib/snapshot-cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DnsRecordView, ZoneRecords } from "@/lib/dns/zone-records";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const actions = vi.hoisted(() => ({
    zoneRecordsAction: vi.fn(),
    deleteDnsRecordAction: vi.fn(),
    saveDnsRecordAction: vi.fn(),
    dnsPropagationAction: vi.fn()
}));
vi.mock("@/app/(app)/account/domains/dns-actions", () => actions);

const { DnsZoneEditor } = await import("@/components/dns/dns-zone-editor");

const ZONE_ID = "0123456789abcdef0123456789abcdef";
const scope = { kind: "instance" as const, zoneId: ZONE_ID };

function view(id: string, type: "A" | "TXT", relative: string, content: string): DnsRecordView {
    return {
        id,
        type,
        name: `${relative}.example.test`,
        relative,
        content,
        ttl: 1,
        proxied: false,
        proxiable: type === "A",
        priority: null,
        draft: { ...emptyDraft(type), name: relative, content }
    };
}

const zone: ZoneRecords = {
    zone: { id: ZONE_ID, name: "example.test" },
    within: null,
    records: [view("r1", "A", "www", "203.0.113.10"), view("r2", "TXT", "_dmarc", "v=DMARC1; p=none")]
};

/** A promise the test settles by hand, so the frame between a click and its answer can be looked at. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

async function mount() {
    render(<DnsZoneEditor scope={scope} />);
    await screen.findByText("203.0.113.10");
}

beforeEach(() => {
    sessionStorage.clear();
    actions.zoneRecordsAction.mockResolvedValue({ zone });
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("entering a zone", () => {
    it("paints the records it showed last while the read behind them is still out", async () => {
        writeSnapshot(`personal:dns.records.${JSON.stringify(scope)}`, zone);
        actions.zoneRecordsAction.mockReturnValue(new Promise(() => undefined));
        render(<DnsZoneEditor scope={scope} />);

        expect(await screen.findByText("203.0.113.10")).toBeTruthy();
        expect(actions.zoneRecordsAction).toHaveBeenCalledTimes(1);
    });

    it("draws its filters and its table before there is anything to list", () => {
        actions.zoneRecordsAction.mockReturnValue(new Promise(() => undefined));
        render(<DnsZoneEditor scope={scope} />);

        expect(screen.getByRole("textbox", { name: "Search records" })).toBeTruthy();
        expect(screen.getByText("Proxy status")).toBeTruthy();
        expect(document.querySelector('tbody[aria-busy="true"]')).not.toBeNull();
    });
});

describe("deleting a record", () => {
    it("asks first, naming the record, and sends nothing until it is confirmed", async () => {
        await mount();
        fireEvent.click(screen.getByRole("button", { name: "Delete the A record www" }));

        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Delete DNS record")).toBeTruthy();
        expect(dialog.textContent).toContain("A");
        expect(dialog.textContent).toContain("www.example.test");
        expect(dialog.textContent).toContain("203.0.113.10");
        expect(actions.deleteDnsRecordAction).not.toHaveBeenCalled();

        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(actions.deleteDnsRecordAction).not.toHaveBeenCalled();
        expect(screen.getByText("203.0.113.10")).toBeTruthy();
    });

    it("takes the row off at once when confirmed, before the answer", async () => {
        const answer = deferred<{ error?: string }>();
        actions.deleteDnsRecordAction.mockReturnValue(answer.promise);
        await mount();

        fireEvent.click(screen.getByRole("button", { name: "Delete the A record www" }));
        fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete record" }));

        expect(actions.deleteDnsRecordAction).toHaveBeenCalledWith(scope, "r1");
        expect(screen.queryByText("203.0.113.10")).toBeNull();

        // Stored: the zone is read again, and what it answers is what stays.
        actions.zoneRecordsAction.mockResolvedValue({ zone: { ...zone, records: [zone.records[1]] } });
        await act(async () => answer.resolve({}));
        expect(actions.zoneRecordsAction).toHaveBeenCalledTimes(2);
        expect(screen.queryByText("203.0.113.10")).toBeNull();
        expect(screen.getByText("v=DMARC1; p=none")).toBeTruthy();
    });

    it("puts the row back and says why when the delete is refused", async () => {
        actions.deleteDnsRecordAction.mockResolvedValue({ error: "Cloudflare refused the change" });
        await mount();

        fireEvent.click(screen.getByRole("button", { name: "Delete the A record www" }));
        fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete record" }));

        expect(await screen.findByText("Cloudflare refused the change")).toBeTruthy();
        expect(screen.getByText("203.0.113.10")).toBeTruthy();
    });
});

describe("adding a record", () => {
    it("shows the row while it is sent, and reopens the form with the reason when it is refused", async () => {
        const answer = deferred<{ error?: string; problems?: Record<string, string> }>();
        actions.saveDnsRecordAction.mockReturnValue(answer.promise);
        await mount();

        fireEvent.click(screen.getAllByRole("button", { name: /Add record/ })[0]!);
        const form = await screen.findByRole("dialog");
        const [name, content] = within(form).getAllByRole("textbox");
        fireEvent.change(name!, { target: { value: "api" } });
        fireEvent.change(content!, { target: { value: "203.0.113.20" } });
        fireEvent.click(within(form).getByRole("button", { name: "Add record" }));

        // In the table, dimmed, before Cloudflare has answered.
        expect(screen.queryByRole("dialog")).toBeNull();
        const row = screen.getByText("203.0.113.20").closest("tr");
        expect(row?.getAttribute("aria-busy")).toBe("true");

        await act(async () => answer.resolve({ error: "Check the highlighted fields", problems: { content: "Already taken" } }));
        expect(screen.queryByText("203.0.113.20", { selector: "code" })).toBeNull();
        const reopened = await screen.findByRole("dialog");
        expect(within(reopened).getByText("Already taken")).toBeTruthy();
        expect(within(reopened).getByDisplayValue("203.0.113.20")).toBeTruthy();
    });

    it("refuses a copy of a record already in the zone as it is typed", async () => {
        await mount();
        fireEvent.click(screen.getAllByRole("button", { name: /Add record/ })[0]!);
        const form = await screen.findByRole("dialog");
        const [name, content] = within(form).getAllByRole("textbox");
        fireEvent.change(name!, { target: { value: "WWW" } });
        fireEvent.change(content!, { target: { value: "203.0.113.10" } });

        expect(within(form).getByText("This A record is already in the zone")).toBeTruthy();
        fireEvent.click(within(form).getByRole("button", { name: "Add record" }));
        expect(actions.saveDnsRecordAction).not.toHaveBeenCalled();
    });
});
