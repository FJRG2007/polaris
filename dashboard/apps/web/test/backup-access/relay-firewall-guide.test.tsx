// @vitest-environment jsdom

/**
 * The firewall steps come up by themselves while something is blocked, name the
 * provider the server is called after, and stay out of the way once all is open.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it } from "vitest";
import type { BackupView } from "@/lib/backup-access/service";
import { cleanup, render, screen } from "@testing-library/react";
import { RelayFirewallGuide } from "@/app/(app)/admin/domains/relay-firewall-guide";

afterEach(cleanup);

function view(relayMs: number | null, relayClosed: number[] | null): BackupView {
    return {
        config: { relayTargetId: "server" },
        servers: [{ id: "server", name: "ionos" }],
        relay: { address: "203.0.113.7", listenPort: 52000, tcp: [80, 443, 7881], udp: [19133] },
        probe: { latency: { direct: 2, tunnel: null, relay: relayMs }, relayClosed }
    } as unknown as BackupView;
}

describe("the relay firewall guide", () => {
    it("opens on its own at the right provider, marking what is blocked", () => {
        render(<RelayFirewallGuide view={view(null, [7881])} />, { wrapper: MessagesWrapper });

        expect(screen.getByRole("link", { name: /Open IONOS/ }).getAttribute("href")).toBe(
            "https://my.ionos.com/account"
        );
        expect(screen.getByText("52000")).toBeTruthy();
        expect(screen.getAllByText("Blocked")).toHaveLength(2);
        expect(screen.getByText("Cannot be checked")).toBeTruthy();
        expect(screen.getByText(/203\.0\.113\.7/)).toBeTruthy();
    });

    it("stays folded once nothing is blocked", () => {
        render(<RelayFirewallGuide view={view(40, [])} />, { wrapper: MessagesWrapper });

        expect(screen.queryByText("52000")).toBeNull();
        expect(screen.getByRole("button", { expanded: false })).toBeTruthy();
    });
});
