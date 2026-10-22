// @vitest-environment jsdom
/**
 * The Network filter screen's status card offers the one action that fits where the
 * blocker stands: Turn on when it is off, Try again when port 53 was taken or held,
 * Turn off once it exists, and Retry on the check itself when that failed.
 */

import { MessagesWrapper } from "../setup/i18n";
import * as dns from "@/lib/dns-blocker/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DnsBlockerState, DnsBlockerStatus } from "@/lib/dns-blocker/service";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

let answer: { error: string } | { status: DnsBlockerStatus };
const turnOnDnsBlockerAction = vi.fn(async () => ({}));
const dnsInsightsAction = vi.fn(async (..._args: unknown[]): Promise<unknown> => insights());

vi.mock("../../src/app/(app)/apps/network-filter/actions", () => ({
    dnsBlockerStatusAction: async () => answer,
    saveDnsSettingsAction: async () => ({}),
    turnOffDnsBlockerAction: async () => ({}),
    turnOnDnsBlockerAction,
    dnsInsightsAction,
    dnsClientsAction: async () => ({ clients: [], logOff: false }),
    dnsHistoryAction: async () => ({
        history: {
            days: 30,
            queries: 0,
            blocked: 0,
            blockedPercent: 0,
            timeline: { from: 0, bucketMs: 86_400_000, allowed: [], blocked: [] },
            topPermitted: [],
            topBlocked: [],
            topClients: [],
            topBlockedClients: [],
            blockedBy: [],
            clientNames: []
        }
    }),
    dnsDevicesAction: async () => ({ devices: [], logOff: false }),
    dnsLookupAction: async () => ({ error: "x" }),
    pauseDnsBlockingAction: async () => ({}),
    dnsListsAction: async () => ({ metrics: null }),
    dnsTailAction: async () => ({ rows: [] }),
    refreshDnsListsAction: async () => ({}),
    ruleFromLogAction: async () => ({}),
    resumeDnsBlockingAction: async () => ({}),
    dnsReputationAction: async () => ({ off: "integrationOff", flagged: [] }),
    recheckDnsReputationAction: async () => ({}),
    editDnsRuleAction: async () => ({ error: "x" })
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
            log: {
                rows: [
                    {
                        time: new Date(0).toISOString(),
                        at: 0,
                        client: "10.0.0.2",
                        clientName: "",
                        domain,
                        type: "A",
                        outcome: "allowed",
                        reason: "RESOLVED",
                        durationMs: 1,
                        via: "cache",
                        list: ""
                    }
                ],
                page: 0,
                hasMore: false
            },
            pause: { enabled: true, secondsLeft: null },
            logOff
        }
    };
}

const replace = vi.fn();
const push = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace, push }),
    usePathname: () => "/apps/network-filter/log",
    useSearchParams: () => new URLSearchParams(search)
}));

const { DnsBlockerProvider } =
    await import("../../src/app/(app)/apps/network-filter/dns-blocker-context");
const { DnsOverviewSection } =
    await import("../../src/app/(app)/apps/network-filter/overview-section");
const { DnsLogSection } = await import("../../src/app/(app)/apps/network-filter/log-section");
const { DnsListsSection } = await import("../../src/app/(app)/apps/network-filter/lists-section");
const { DnsDevicesSection } =
    await import("../../src/app/(app)/apps/network-filter/devices-section");

/** One section of the screen, inside the provider its layout gives it. */
function mount(
    Section: () => React.ReactElement,
    initial: dns.DnsSettings = dns.DEFAULT_DNS_SETTINGS
) {
    return render(
        <MessagesWrapper>
            <DnsBlockerProvider initial={initial}>
                <Section />
            </DnsBlockerProvider>
        </MessagesWrapper>
    );
}

const Overview = () => <DnsOverviewSection brands={[]} />;

function standing(state: DnsBlockerState): void {
    answer = {
        status: { state, address: "192.168.1.5", settings: dns.DEFAULT_DNS_SETTINGS, stale: false }
    };
}

async function shown(Section: () => React.ReactElement = Overview): Promise<string[]> {
    mount(Section);
    await waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
    return ["Turn on", "Turn off", "Try again"].filter((label) =>
        screen.queryByRole("button", { name: label })
    );
}

afterEach(() => {
    cleanup();
    search = "";
    replace.mockClear();
    push.mockClear();
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
        await shown(DnsLogSection);
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
        await shown(DnsLogSection);
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
        const bars = [...document.querySelectorAll("[data-outcome]")].map((bar) =>
            bar.getAttribute("data-outcome")
        );
        expect(bars).toEqual(["blocked", "allowed"]);
        const time = document.querySelector("[data-outcome]")?.parentElement;
        expect(time?.className).not.toContain("truncate");
    });
});

describe("rowTime", () => {
    it("drops the date for today's rows and keeps it otherwise", async () => {
        const { rowTime } = await import("../../src/app/(app)/apps/network-filter/dns-insights");
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
        await shown(DnsDevicesSection);
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
        expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
    });
});

describe("DnsBlockerView schedules", () => {
    it("offers only the categories that have a list on, and adds a valid schedule", async () => {
        standing("off");
        mount(DnsListsSection, {
            ...dns.DEFAULT_DNS_SETTINGS,
            sources: ["hagezi-pro", "hagezi-social"]
        });
        await waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
        const section = within(screen.getByText("Schedules").closest("div")!.parentElement!);
        expect(section.queryByRole("switch", { name: "Adult" })).toBeNull();
        const add = section.getByRole("button", { name: "Add schedule" });
        fireEvent.click(section.getByRole("switch", { name: "Social" }));
        expect(add).toHaveProperty("disabled", true);
        fireEvent.click(section.getByRole("button", { name: "Mon" }));
        expect(add).toHaveProperty("disabled", false);
        fireEvent.change(section.getByLabelText("Until"), { target: { value: "21:00" } });
        expect(section.getByText("The start and the end cannot be the same time.")).toBeTruthy();
        expect(add).toHaveProperty("disabled", true);
        fireEvent.change(section.getByLabelText("Until"), { target: { value: "07:00" } });
        fireEvent.click(add);
        expect(section.getByText("Mon, 21:00 - 07:00")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
    });

    it("says to turn a list on when none is", async () => {
        standing("off");
        mount(DnsListsSection, { ...dns.DEFAULT_DNS_SETTINGS, sources: [] });
        expect(screen.getByText("Turn on a list above to schedule it.")).toBeTruthy();
    });

    it("offers to apply when the server runs older settings", async () => {
        answer = {
            status: {
                state: "blocking",
                address: "192.168.1.5",
                settings: dns.DEFAULT_DNS_SETTINGS,
                stale: true
            }
        };
        dnsInsightsAction.mockImplementation(async () => insights());
        mount(DnsListsSection, dns.DEFAULT_DNS_SETTINGS);
        fireEvent.click(await screen.findByRole("button", { name: "Apply now" }));
        await waitFor(() => expect(turnOnDnsBlockerAction).toHaveBeenCalled());
    });
});

describe("DnsBlockerView blocked services", () => {
    it("turns a service on, and offers it to schedules once it is on", async () => {
        standing("off");
        mount(DnsListsSection, { ...dns.DEFAULT_DNS_SETTINGS, sources: [] });
        await waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
        expect(screen.getByText("Turn on a list above to schedule it.")).toBeTruthy();
        fireEvent.click(screen.getByRole("switch", { name: "YouTube" }));
        expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
        const section = within(screen.getByText("Schedules").closest("div")!.parentElement!);
        expect(section.getByRole("switch", { name: "YouTube" })).toBeTruthy();
    });
});

describe("DnsBlockerView unchanged settings", () => {
    it("keeps Save off for stored settings with services, schedules and groups", async () => {
        standing("off");
        const initial = dns.readDnsSettings({
            sources: ["hagezi-social"],
            services: ["youtube"],
            serviceDomains: { youtube: ["*.youtube.com"] },
            schedules: [{ lists: ["social"], days: ["mon"], start: "21:00", end: "07:00" }],
            timeZone: "Europe/Madrid",
            clientGroups: [{ name: "Kids", clients: ["10.0.0.9"], categories: [] }]
        });
        mount(DnsListsSection, initial);
        await waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
        expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByText("Mon, 21:00 - 07:00")).toBeTruthy();
    });
});

describe("Network filter sections", () => {
    it("opens the log on a device picked on the Overview", async () => {
        standing("blocking");
        await shown();
        const device = await screen.findAllByRole("button", { name: /10\.0\.0\.2/ });
        fireEvent.click(device[0]!);
        expect(push).toHaveBeenCalledWith("/apps/network-filter/log?client=10.0.0.2");
    });

    it("reads the log's filter from a link and keeps it in the address", async () => {
        standing("blocking");
        search = "client=10.0.0.2&domain=Example.COM&outcome=blocked&range=nonsense";
        await shown(DnsLogSection);
        await waitFor(() => expect(dnsInsightsAction).toHaveBeenCalled());
        expect(dnsInsightsAction.mock.calls[0]![0]).toMatchObject({
            client: "10.0.0.2",
            search: "example.com",
            outcome: "blocked",
            range: "24h"
        });
        await waitFor(() =>
            expect(replace).toHaveBeenCalledWith(
                "/apps/network-filter/log?client=10.0.0.2&domain=example.com&outcome=blocked",
                { scroll: false }
            )
        );
    });

    it("keeps an edit made in one section while another is open", async () => {
        standing("off");
        mount(() => (
            <>
                <DnsListsSection />
                <DnsDevicesSection />
            </>
        ));
        await waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
        fireEvent.click(screen.getByRole("switch", { name: "YouTube" }));
        const saves = screen.getAllByRole("button", { name: "Save" });
        expect(saves).toHaveLength(2);
        for (const save of saves) expect(save.hasAttribute("disabled")).toBe(false);
    });
});

describe("Network filter rail", () => {
    it("gives every section its own screen in the rail", async () => {
        const nav = await import("@/lib/apps");
        const subapp = nav.resolveSubapp("/apps/network-filter/lists");
        expect(subapp?.id).toBe("dns-blocker");
        expect(subapp?.sections.map((section) => section.href)).toEqual([
            "/apps/network-filter",
            "/apps/network-filter/log",
            "/apps/network-filter/lists",
            "/apps/network-filter/devices",
            "/apps/network-filter/local-dns",
            "/apps/network-filter/settings"
        ]);
        expect(subapp?.sections.every((section) => section.requiresApp === "dns-blocker")).toBe(
            true
        );
    });
});
