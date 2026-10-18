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

vi.mock("../../src/app/(app)/apps/dns-blocker/actions", () => ({
    dnsBlockerStatusAction: async () => answer,
    saveDnsSettingsAction: async () => ({}),
    turnOffDnsBlockerAction: async () => ({}),
    turnOnDnsBlockerAction
}));

const { DnsBlockerView } = await import("../../src/app/(app)/apps/dns-blocker/dns-blocker-view");

function standing(state: DnsBlockerState): void {
    answer = { status: { state, address: "192.168.1.5", settings: dns.DEFAULT_DNS_SETTINGS } };
}

async function shown(): Promise<string[]> {
    render(
        <MessagesWrapper>
            <DnsBlockerView initial={dns.DEFAULT_DNS_SETTINGS} />
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
