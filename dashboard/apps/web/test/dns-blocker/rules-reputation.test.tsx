// @vitest-environment jsdom
/**
 * The network filter's own rules edited one at a time, and the reputation
 * lookups' pure half: which names are asked about, what the DNS server is
 * handed, and the configuration that names those files.
 */

import { MessagesWrapper } from "../setup/i18n";
import * as rules from "@/lib/dns-blocker/rules";
import * as dns from "@/lib/dns-blocker/settings";
import { blockyConfig } from "@/lib/dns-blocker/render";
import * as reputation from "@/lib/dns-blocker/reputation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const editDnsRuleAction = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
    error: "Saving failed"
}));

vi.mock("../../src/app/(app)/apps/network-filter/actions", () => ({
    dnsBlockerStatusAction: async () => ({ error: "x" }),
    saveDnsSettingsAction: async () => ({}),
    editDnsRuleAction,
    dnsReputationAction: async () => ({ off: null, flagged: [] }),
    recheckDnsReputationAction: async () => ({}),
    ruleFromLogAction: async () => ({})
}));

afterEach(() => {
    cleanup();
    editDnsRuleAction.mockClear();
});

describe("rule edits", () => {
    const base = { allow: ["good.example"], deny: ["ads.example", "*.tracker.example"] };
    const from = { action: "deny" as const, rule: "ads.example" };

    it("tells the three shapes apart", () => {
        expect(rules.ruleKind("ads.example")).toBe("exact");
        expect(rules.ruleKind("*.tracker.example")).toBe("wildcard");
        expect(rules.ruleKind("/^ad[0-9]*\\./")).toBe("regex");
    });

    it("validates with the settings' own normalizer", () => {
        const parsed = rules.dnsRuleInputSchema.safeParse({
            action: "deny",
            rule: " ADS.Example "
        });
        expect(parsed.success && parsed.data.rule).toBe("ads.example");
        const bad = (rule: string) =>
            rules.dnsRuleInputSchema.safeParse({ action: "deny", rule }).success;
        expect(bad("not a name")).toBe(false);
        expect(bad("/(?=x)/")).toBe(false);
    });

    it("adds, refuses a duplicate, and moves a name out of the other action", () => {
        const add = (action: "allow" | "deny", rule: string) =>
            rules.applyRuleEdit(base, { op: "add", next: { action, rule } });
        expect(add("deny", "ads.example")).toBe("duplicate");
        expect(add("deny", "good.example")).toEqual({
            allow: [],
            deny: ["ads.example", "*.tracker.example", "good.example"]
        });
    });

    it("edits in place, across actions, and deletes", () => {
        const edit = (action: "allow" | "deny", rule: string) =>
            rules.applyRuleEdit(base, { op: "edit", from, next: { action, rule } });
        expect(edit("deny", "ad.example")).toEqual({
            allow: ["good.example"],
            deny: ["ad.example", "*.tracker.example"]
        });
        expect(edit("allow", "ads.example")).toEqual({
            allow: ["good.example", "ads.example"],
            deny: ["*.tracker.example"]
        });
        expect(rules.applyRuleEdit(base, { op: "delete", from })).toEqual({
            allow: ["good.example"],
            deny: ["*.tracker.example"]
        });
        const gone = { action: "allow" as const, rule: "x.example" };
        expect(rules.applyRuleEdit(base, { op: "delete", from: gone })).toBe("missing");
    });
});

describe("reputation", () => {
    const line = (domain: string, response = "RESOLVED", reason = "RESOLVED (1.1.1.1)") =>
        [
            "2026-10-21 10:00:00",
            "192.168.1.20",
            "phone",
            "3",
            reason,
            `${domain}.`,
            "",
            "",
            response,
            "A"
        ].join("\t");

    const log = (...domains: string[]) => domains.map((domain) => `${line(domain)}\n`).join("");
    const read = (text: string, offset: number, maxBytes?: number, chunk = 7) => {
        const slice = new reputation.LogSlice(offset, maxBytes);
        const bytes = Buffer.from(text);
        for (let at = 0; at < bytes.length; at += chunk)
            if (!slice.add(bytes.subarray(at, at + chunk))) break;
        return slice.finish();
    };

    it("reads allowed public names once each, in order, from the cursor on", () => {
        const text =
            log("a.example") +
            `${line("blocked.example", "BLOCKED", "BLOCKED (ads)")}\n` +
            log("nas.lan", "printer", "b.example", "a.example", "10.0.0.1");
        const all = read(text, 0);
        expect(all.entries.map((entry) => entry.domain)).toEqual(["a.example", "b.example"]);
        expect(all).toMatchObject({
            end: Buffer.byteLength(text),
            truncated: false,
            complete: true
        });
        const fromB = read(text, all.entries[1]!.start);
        expect(fromB.entries.map((entry) => entry.domain)).toEqual(["b.example", "a.example"]);
    });

    it("leaves a half-written last line for the next pass", () => {
        const text = `${log("a.example")}${line("b.example").slice(0, 20)}`;
        const slice = read(text, 0);
        expect(slice.entries.map((entry) => entry.domain)).toEqual(["a.example"]);
        expect(slice.end).toBe(Buffer.byteLength(log("a.example")));
    });

    it("catches up over passes when a pass may read only so much", () => {
        const text = log("a.example", "b.example", "c.example", "d.example");
        const lineBytes = Buffer.byteLength(log("a.example"));
        const seen: string[] = [];
        let offset = 0;
        for (let pass = 0; pass < 10 && offset < Buffer.byteLength(text); pass += 1) {
            const slice = read(text, offset, lineBytes * 2);
            seen.push(...slice.entries.map((entry) => entry.domain));
            offset = reputation.cursorAfter(slice.entries, new Set(seen), slice.end);
        }
        expect(seen).toEqual(["a.example", "b.example", "c.example", "d.example"]);
        expect(offset).toBe(Buffer.byteLength(text));
    });

    it("stops the cursor at the first name the budget did not reach", () => {
        const text = log("a.example", "b.example", "c.example");
        const slice = read(text, 0);
        const handled = new Set(["a.example"]);
        expect(reputation.cursorAfter(slice.entries, handled, slice.end)).toBe(
            slice.entries[1]!.start
        );
        handled.add("b.example").add("c.example");
        expect(reputation.cursorAfter(slice.entries, handled, slice.end)).toBe(slice.end);
    });

    it("notices a file shorter than the cursor, cut or replaced", () => {
        expect(read(log("a.example"), 10_000).truncated).toBe(true);
    });

    it("finishes the day the cursor is in before starting the new one", () => {
        expect(reputation.readPlan(null, "/logs/2026-10-21.log")).toEqual([
            { file: "/logs/2026-10-21.log", offset: 0 }
        ]);
        expect(
            reputation.readPlan({ file: "/logs/2026-10-21.log", offset: 9 }, "/logs/2026-10-21.log")
        ).toEqual([{ file: "/logs/2026-10-21.log", offset: 9 }]);
        expect(
            reputation.readPlan({ file: "/logs/2026-10-20.log", offset: 9 }, "/logs/2026-10-21.log")
        ).toEqual([
            { file: "/logs/2026-10-20.log", offset: 9 },
            { file: "/logs/2026-10-21.log", offset: 0 }
        ]);
    });

    it("keeps a flagged verdict longer than a clean one", () => {
        expect(reputation.verdictExpiry(true, 0).getTime()).toBe(reputation.FLAGGED_TTL_MS);
        expect(reputation.verdictExpiry(false, 0).getTime()).toBe(reputation.CLEAN_TTL_MS);
    });

    it("writes one sorted file per category, never a missing one", () => {
        const head = "# Polaris: domains Dymo flagged\n";
        const files = reputation.reputationFiles(
            [
                { domain: "b.example", fraud: true, adult: false },
                { domain: "a.example", fraud: true, adult: true }
            ],
            ["fraud", "adult"]
        );
        expect(files.get("fraud")).toBe(`${head}a.example\nb.example\n`);
        expect(files.get("adult")).toBe(`${head}a.example\n`);
        expect(reputation.reputationFiles([], ["fraud"]).get("fraud")).toBe(head);
    });

    it("names the log's list as its category", () => {
        expect(reputation.reputationCategoryOf("dymo-fraud")).toBe("fraud");
        expect(reputation.reputationCategoryOf("ads")).toBeNull();
    });

    it("is off in stored settings that predate it, and keeps a valid choice", () => {
        const off = { fraud: false, adult: false };
        expect(dns.readDnsSettings({}).reputation).toEqual(off);
        expect(
            dns.readDnsSettings({ reputation: { fraud: true, adult: "yes" } }).reputation
        ).toEqual(off);
        const on = dns.readDnsSettings({ reputation: { fraud: true, adult: false } });
        expect(on.reputation.fraud).toBe(true);
    });

    it("renders nothing new until a category is on, then a list every device blocks", () => {
        type Blocking = {
            blocking: {
                denylists: Record<string, string[]>;
                clientGroupsBlock: Record<string, string[]>;
            };
        };
        const off = blockyConfig(dns.DEFAULT_DNS_SETTINGS) as Blocking;
        expect(Object.keys(off.blocking.denylists).some((list) => list.startsWith("dymo-"))).toBe(
            false
        );
        const on = blockyConfig({
            ...dns.DEFAULT_DNS_SETTINGS,
            reputation: { fraud: true, adult: false },
            clientGroups: [{ name: "Kids", clients: ["192.168.1.5"], categories: [], services: [] }]
        } as dns.DnsSettings) as Blocking;
        expect(on.blocking.denylists["dymo-fraud"]).toEqual(["/logs/reputation-fraud.txt"]);
        expect(on.blocking.clientGroupsBlock.default).toContain("dymo-fraud");
        expect(on.blocking.clientGroupsBlock["192.168.1.5"]).toContain("dymo-fraud");
    });
});

describe("the rules editor", () => {
    async function draw(settings: Partial<dns.DnsSettings>) {
        const { DnsBlockerProvider } =
            await import("../../src/app/(app)/apps/network-filter/dns-blocker-context");
        const { DnsRulesEditor } =
            await import("../../src/app/(app)/apps/network-filter/rules-editor");
        render(
            <MessagesWrapper>
                <DnsBlockerProvider initial={{ ...dns.DEFAULT_DNS_SETTINGS, ...settings }}>
                    <DnsRulesEditor />
                </DnsBlockerProvider>
            </MessagesWrapper>
        );
    }

    it("shows an empty state with no rules", async () => {
        await draw({});
        expect(screen.getByText("No rules yet")).toBeTruthy();
    });

    it("lists each rule with its shape and action, and filters by search", async () => {
        await draw({ allow: ["good.example"], deny: ["*.tracker.example"] });
        expect(screen.getByText("good.example")).toBeTruthy();
        expect(screen.getByText("Wildcard")).toBeTruthy();
        expect(screen.getByText("Block")).toBeTruthy();
        fireEvent.change(screen.getByRole("textbox", { name: "Search rules" }), {
            target: { value: "tracker" }
        });
        expect(screen.queryByText("good.example")).toBeNull();
    });

    it("removes a rule at once and puts it back when the save fails", async () => {
        await draw({ deny: ["ads.example"] });
        fireEvent.click(screen.getByRole("button", { name: "Remove ads.example" }));
        expect(editDnsRuleAction).toHaveBeenCalledWith({
            op: "delete",
            from: { action: "deny", rule: "ads.example" }
        });
        await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Saving failed"));
        expect(screen.getByText("ads.example")).toBeTruthy();
    });

    it("checks the rule as it is typed in the dialog", async () => {
        await draw({});
        fireEvent.click(screen.getAllByRole("button", { name: "Add rule" })[0]!);
        const field = await screen.findByPlaceholderText("ads.example.com");
        fireEvent.change(field, { target: { value: "bad_name" } });
        expect(field.getAttribute("aria-invalid")).toBe("true");
        fireEvent.change(field, { target: { value: "*.ads.example" } });
        expect(field.getAttribute("aria-invalid")).toBe("false");
        expect(screen.getByText("Read as: Wildcard")).toBeTruthy();
    });

    it("adds several pasted at once, naming the ones left out and why", async () => {
        await draw({ deny: ["kept.example"] });
        fireEvent.click(screen.getAllByRole("button", { name: "Add rule" })[0]!);
        const field = await screen.findByPlaceholderText("ads.example.com");
        fireEvent.change(field, {
            target: { value: "google.*, https://ads.example/x\nbad_name kept.example ADS.example" }
        });
        expect(field.getAttribute("aria-invalid")).toBe("true");
        expect(screen.getByText("2 rules to add")).toBeTruthy();
        expect(screen.getByText("3 entries left out")).toBeTruthy();
        expect(screen.getByText("not a name, *.name, name.* or /regex/")).toBeTruthy();
        expect(screen.getByText("already a rule for this action")).toBeTruthy();
        expect(screen.getByText("repeated in this list")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Add 2 rules" }));
        expect(editDnsRuleAction).toHaveBeenCalledWith({
            op: "addMany",
            next: { action: "deny", rules: ["google.*", "ads.example"] }
        });
    });

    it("says a paste is more than the list has room for instead of sending it", async () => {
        const full = Array.from({ length: dns.DNS_LIMITS.rules - 1 }, (_, at) => `n${at}.example`);
        await draw({ deny: full });
        fireEvent.click(screen.getAllByRole("button", { name: "Add rule" })[0]!);
        const field = await screen.findByPlaceholderText("ads.example.com");
        fireEvent.change(field, { target: { value: "one.example two.example" } });
        expect(screen.getByText("That is as many rules as one list holds.")).toBeTruthy();
        const add = screen.getByRole("button", { name: "Add 2 rules" });
        expect(add.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(add);
        expect(editDnsRuleAction).not.toHaveBeenCalled();
        fireEvent.change(field, { target: { value: "one.example" } });
        expect(screen.queryByText("That is as many rules as one list holds.")).toBeNull();
    });

    it("says in words what a pattern covers", async () => {
        await draw({ deny: ["google.*", "*.tracker.example"] });
        expect(
            screen.getByText("google with any ending, like .com or .co.uk, and what is under it")
        ).toBeTruthy();
        expect(screen.getByText("tracker.example and everything under it")).toBeTruthy();
    });
});
