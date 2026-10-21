/**
 * The Overview's network filter card, in each state it can be drawn in: still
 * reading, unreadable, not running, blocking, and paused - in English and in
 * Spanish.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OverviewDnsBlocker } from "@/lib/overview/overview-service";

vi.mock("@/app/(app)/apps/dns-blocker/actions", () => ({
    pauseDnsBlockingAction: async () => ({}),
    resumeDnsBlockingAction: async () => ({})
}));

const { DnsBlockerWidget } = await import("@/app/(app)/home/widgets/dns-blocker");

function today(pause: { enabled: boolean; secondsLeft: number | null }): OverviewDnsBlocker {
    return {
        today: {
            queries: 12345,
            blocked: 2469,
            blockedPercent: 20,
            hourly: [
                { allowed: 10, blocked: 2 },
                { allowed: 30, blocked: 9 },
                { allowed: 20, blocked: 4 }
            ],
            pause
        }
    };
}

function draw(data: OverviewDnsBlocker | null | undefined, locale?: "es-ES"): string {
    return renderToStaticMarkup(withMessages(<DnsBlockerWidget data={data} />, locale));
}

describe("the network filter card", () => {
    it("holds the figures' shape while they are read", () => {
        expect(draw(undefined)).toContain('aria-busy="true"');
    });

    it("says when it could not be read", () => {
        expect(draw(null)).toContain("The network filter could not be read just now.");
    });

    it("says blocking is off and links to the app when the DNS server is not running", () => {
        const markup = draw({ today: null });
        expect(markup).toContain("Blocking is off");
        expect(markup).toContain('href="/apps/dns-blocker"');
    });

    it("shows today's figures, the line, and a pause while blocking", () => {
        const markup = draw(today({ enabled: true, secondsLeft: null }));
        expect(markup).toContain("12,345");
        expect(markup).toContain("2,469");
        expect(markup).toContain("20%");
        expect(markup).toContain("Blocking");
        expect(markup).toContain("Pause 15 min");
        expect(markup.match(/<path /g)).toHaveLength(2);
    });

    it("shows how long a pause has left, and offers to resume", () => {
        const markup = draw(today({ enabled: false, secondsLeft: 299 }));
        expect(markup).toContain("Paused for 5 min");
        expect(markup).toContain("Resume");
    });

    it("reads in Spanish", () => {
        const paused = draw(today({ enabled: false, secondsLeft: null }), "es-ES");
        expect(paused).toContain("En pausa");
        expect(paused).toContain("Reanudar");
        expect(paused).toContain("Consultas, últimas 24 h");
        expect(draw({ today: null }, "es-ES")).toContain("El bloqueo está apagado");
    });
});
