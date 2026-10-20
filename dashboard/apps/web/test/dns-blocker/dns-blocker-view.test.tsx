// @vitest-environment jsdom
/**
 * The Ad blocker screen's status card offers the one action that fits where the
 * blocker stands: Turn on when it is off, Try again when port 53 was taken or held,
 * Turn off once it exists, and Retry on the check itself when that failed.
 */

import { MessagesWrapper } from "../setup/i18n";
import * as dns from "@/lib/dns-blocker/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DnsBlockerState, DnsBlockerStatus } from "@/lib/dns-blocker/service";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let answer: { error: string } | { status: DnsBlockerStatus };
const turnOnDnsBlockerAction = vi.fn(async () => ({}));
const dnsInsightsAction = vi.fn(async (..._args: unknown[]): Promise<unknown> => insights());

vi.mock("../../src/app/(app)/apps/dns-blocker/actions", () => ({
    dnsBlockerStatusAction: async () => answer,
    saveDnsSettingsAction: async () => ({}),
    turnOffDnsBlockerAction: async () => ({}),
    turnOnDnsBlockerAction,
    dnsInsightsAction,
    dnsClientsAction: async () => ({ clients: [], logOff: false }),
    pauseDnsBlockingAction: async () => ({}),
    dnsListsAction: async () => ({ metrics: null }),
    dnsTailAction: async () => ({ rows: [] }),
    refreshDnsListsAction: async () => ({}),
    ruleFromLogAction: async () => ({}),
    resumeDnsBlockingAction: async () => ({})
}));

function insights(logOff = false, domain = "example.com") {
    return {
        insights: {
            stats: {
                queries: 1,
                blocked: 0,
                blockedPercent: 0,
                timeline: { from: 0, bucketMs: 600_000, allowed: [1, 0], blocked: [0, 0] },
                clientSeries: [],
                queryTypes: [{ name: "A", count: 1 }],
                destinations: [{ name: "cache", count: 1 }],
                blockedBy: [],
                topPermitted: [{ name: domain, count: 1 }],
                topBlocked: [],
                topClients: [{ name: "10.0.0.2", count: 1 }],
                topBlockedClients: [],
                clients: [{ address: "10.0.0.2", name: "" }]
            },
            log: { rows: [], page: 0, hasMore: false },
            pause: { enabled: true, secondsLeft: null },
            logOff
        }
    };
}

const { DnsBlockerView } = await import("../../src/app/(app)/apps/dns-blocker/dns-blocker-view");

function standing(state: DnsBlockerState): void {
    answer = { status: { state, address: "192.168.1.5", settings: dns.DEFAULT_DNS_SETTINGS } };
}

async function shown(): Promise<string[]> {
    render(
        <MessagesWrapper>
            <DnsBlockerView initial={dns.DEFAULT_DNS_SETTINGS} brands={[]} />
        </MessagesWrapper>
    );
    await waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
    return ["Turn on", "Turn off", "Try again"].filter((label) =>
        screen.queryByRole("button", { name: label })
    );
}

afterEach(() => {
    cleanup();
    turnOnDnsBlockerAction.mockClear();
    dnsInsightsAction.mockReset();
    dnsInsightsAction.mockImplementation(async () => insights());
});

describe("DnsBlockerView status", () => {
    it.each([
        ["off", ["Turn on"]],
        ["portTaken", ["Try again"]],
        ["starting", ["Turn off"]],
        ["portHeld", ["Turn off", "Try again"]],
        ["conflict", ["Turn off", "Try again"]],
        ["blocking", ["Turn off"]]
    ] as const)("offers what fits %s", async (state, expected) => {
        standing(state);
        expect(await shown()).toEqual(expected);
    });

    it("cannot turn on without an address on the network", async () => {
        standing("noAddress");
        expect(await shown()).toEqual(["Turn on"]);
        expect(screen.getByRole("button", { name: "Turn on" })).toHaveProperty("disabled", true);
    });

    it("turns on from Try again when port 53 was held", async () => {
        standing("portHeld");
        await shown();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(turnOnDnsBlockerAction).toHaveBeenCalledTimes(1));
    });

    it("says why the check failed and offers it again", async () => {
        answer = { error: "The check did not answer." };
        expect(await shown()).toEqual(["Try again"]);
        expect(screen.getByRole("alert").textContent).toBe("The check did not answer.");
    });
});

describe("DnsBlockerView today", () => {
    it.each(["off", "portTaken", "starting", "portHeld", "conflict"] as const)(
        "is not shown while %s",
        async (state) => {
            standing(state);
            await shown();
            expect(screen.queryByText("Activity")).toBeNull();
            expect(dnsInsightsAction).not.toHaveBeenCalled();
        }
    );

    it("is shown while blocking", async () => {
        standing("blocking");
        await shown();
        await waitFor(() => expect(screen.getAllByText("example.com").length).toBeGreaterThan(0));
    });

    it("offers to apply the settings when the server records no lookups", async () => {
        standing("blocking");
        dnsInsightsAction.mockImplementation(async () => insights(true));
        await shown();
        const apply = await screen.findByRole("button", { name: "Apply" });
        fireEvent.click(apply);
        await waitFor(() => expect(turnOnDnsBlockerAction).toHaveBeenCalledTimes(1));
    });

    it("keeps the newest answer when an older one arrives last", async () => {
        standing("blocking");
        let releaseFirst: (value: unknown) => void = () => undefined;
        dnsInsightsAction
            .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
            .mockImplementation(async () => insights(false, "newest.example"));
        await shown();
        await waitFor(() => expect(dnsInsightsAction).toHaveBeenCalledTimes(1));
        fireEvent.change(screen.getByRole("textbox", { name: "Search a domain" }), {
            target: { value: "newest" }
        });
        await waitFor(() =>
            expect(screen.getAllByText("newest.example").length).toBeGreaterThan(0)
        );
        releaseFirst(insights(false, "stale.example"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByText("stale.example")).toBeNull();
    });
});

describe("DnsBlockerView query log", () => {
    function row(domain: string, outcome: "blocked" | "allowed", at: number) {
        return {
            time: new Date(at).toISOString(),
            at,
            client: "10.0.0.2",
            clientName: "",
            domain,
            type: "A",
            outcome,
            reason: outcome === "blocked" ? "BLOCKED (ads)" : "RESOLVED",
            durationMs: 1,
            via: outcome === "blocked" ? "blocked" : "cache",
            list: outcome === "blocked" ? "ads" : ""
        };
    }

    it("shows the outcome on the row instead of a column of its own", async () => {
        standing("blocking");
        const now = Date.now();
        dnsInsightsAction.mockImplementation(async () => {
            const base = insights();
            return {
                insights: {
                    ...base.insights,
                    log: {
                        rows: [
                            row("tracker.blocked.example", "blocked", now),
                            row("fine.allowed.example", "allowed", now)
                        ],
                        page: 0,
                        hasMore: false
                    }
                }
            };
        });
        await shown();
        const button = (text: string) =>
            [...document.querySelectorAll("button")].find(
                (item) => item.textContent === text
            ) as HTMLButtonElement;
        await waitFor(() => expect(button("Blocked: tracker.blocked.example")).toBeTruthy());
        const blocked = button("Blocked: tracker.blocked.example");
        expect(blocked.className).toContain("text-danger-ink");
        const allowed = button("Allowed: fine.allowed.example");
        expect(blocked.className).toContain("line-through");
        expect(allowed.className).not.toContain("text-danger-ink");
        expect(allowed.className).not.toContain("line-through");
        expect(blocked.className).not.toContain("truncate");
        const headers = [...document.querySelectorAll("th")].map((cell) => cell.textContent);
        expect(headers).not.toContain("Result");
        const bars = [...document.querySelectorAll("[data-outcome]")].map(
            (bar) => bar.getAttribute("data-outcome")
        );
        expect(bars).toEqual(["blocked", "allowed"]);
        const time = document.querySelector("[data-outcome]")?.parentElement;
        expect(time?.className).not.toContain("truncate");
    });
});

describe("rowTime", () => {
    it("drops the date for today's rows and keeps it otherwise", async () => {
        const { rowTime } = await import("../../src/app/(app)/apps/dns-blocker/dns-insights");
        const now = new Date(2026, 9, 20, 15, 0, 0);
        const today = new Date(2026, 9, 20, 9, 5, 7).getTime();
        const yesterday = new Date(2026, 9, 19, 9, 5, 7).getTime();
        expect(rowTime(today, now)).toBe(new Date(today).toLocaleTimeString());
        expect(rowTime(yesterday, now)).not.toBe(new Date(yesterday).toLocaleTimeString());
        expect(rowTime(yesterday, now)).toContain("19");
    });
});

describe("DnsBlockerView device names", () => {
    it("adds a name only when both fields are valid, and says which one is not", async () => {
        standing("off");
        await shown();
        const add = screen.getByRole("button", { name: "Name it" });
        fireEvent.change(screen.getByRole("textbox", { name: "Device name" }), {
            target: { value: "ana laptop" }
        });
        fireEvent.change(screen.getByRole("textbox", { name: "Device address" }), {
            target: { value: "192.168.1.20" }
        });
        expect(add).toHaveProperty("disabled", true);
        expect(screen.getByText("Letters, digits, dots and dashes; no spaces.")).toBeTruthy();
        fireEvent.change(screen.getByRole("textbox", { name: "Device name" }), {
            target: { value: "Ana-Laptop" }
        });
        expect(add).toHaveProperty("disabled", false);
        fireEvent.change(screen.getByRole("textbox", { name: "Device address" }), {
            target: { value: "fd00::zz" }
        });
        expect(add).toHaveProperty("disabled", true);
        expect(screen.getByText("Not an IP address, like 192.168.1.20.")).toBeTruthy();
        fireEvent.change(screen.getByRole("textbox", { name: "Device address" }), {
            target: { value: "fd00::20" }
        });
        expect(add).toHaveProperty("disabled", false);
        fireEvent.click(add);
        expect(screen.getByText("ana-laptop")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(
            false
        );
    });
});
