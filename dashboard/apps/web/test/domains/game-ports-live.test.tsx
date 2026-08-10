/**
 * The game-ports section of the Domains panel.
 *
 * It is read by someone with their router open in the other window, so the two
 * things it must never do are paint nothing over a reading it was handed, and
 * print a rule the form in front of them will refuse. Both are asserted from the
 * markup it renders.
 *
 * Rendered to static markup: the reading and the poll behind it belong to the card
 * this sits in, which is what decides there is a card at all - so every case here
 * differs only in what this one is handed.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_PORT_BLOCKS } from "../../src/lib/apps/port-block";
import type { GamePortsReading } from "../../src/lib/apps/games-service";
import { GamePortsLive } from "../../src/app/(app)/admin/domains/game-ports-live";
import { gameReachAdvice, gameStoppedAdvice } from "../../src/lib/apps/minecraft/reach-advice";

const pending = [{ port: 25565, protocol: "tcp" as const }];

function markupFor(shown: GamePortsReading): string {
    return renderToStaticMarkup(
        <GamePortsLive reading={shown} stale={null} refreshing={false} onRefresh={() => {}} />
    );
}

const reading: GamePortsReading = {
    servers: [
        { installedAppId: "one", name: "Survival", ports: pending, confirmed: false, confirmedAt: null, running: true },
        {
            installedAppId: "two",
            name: "Creative",
            ports: [{ port: 25566, protocol: "tcp" }],
            confirmed: true,
            confirmedAt: "2026-08-01T10:00:00.000Z",
            running: true
        }
    ],
    // Listening: the server is up and simply unproven, which is the state that
    // has anything to say about the router at all.
    advice: gameReachAdvice("home-nat", pending, false, "192.168.1.142", "range", DEFAULT_PORT_BLOCKS, true),
    lanIp: "192.168.1.142",
    policy: "range",
    blocks: DEFAULT_PORT_BLOCKS
};

describe("the game ports section", () => {
    it("paints the servers it was handed rather than waiting for its own read", () => {
        const markup = markupFor(reading);

        expect(markup).toContain("Survival");
        expect(markup).toContain("Not confirmed");
        expect(markup).toContain("Reached from outside");
    });

    it("says what is still in the way, for the servers that are not proven", () => {
        const markup = markupFor(reading);

        // Unconfirmed, not "has to be forwarded": from in here a forward that
        // exists and one that does not look the same, and demanding the operator
        // open a port they already opened is how this page loses their trust.
        expect(markup).toContain("not confirmed");
        expect(markup).toContain("If it is not open yet");
        // The range policy asks for the block, not the one port in use today.
        expect(markup).toContain("25565-25664");
    });

    it("asks for nothing at all while the server is still starting", () => {
        const starting: GamePortsReading = {
            ...reading,
            advice: gameReachAdvice("home-nat", pending, false, "192.168.1.142", "range", DEFAULT_PORT_BLOCKS, false)
        };
        const markup = markupFor(starting);

        expect(markup).not.toContain("If it is not open yet");
        expect(markup).toContain("cannot be checked");
    });

    it("asks for nothing about a server that is turned off, and does not call it unconfirmed", () => {
        const off: GamePortsReading = {
            ...reading,
            servers: reading.servers.map((server) =>
                server.installedAppId === "one" ? { ...server, running: false } : server
            ),
            advice: gameStoppedAdvice(pending)
        };
        const markup = markupFor(off);

        // The whole point of the state: the port was never measured, so neither
        // claim about the router may be printed over it.
        expect(markup).not.toContain("Not confirmed");
        expect(markup).not.toContain("If it is not open yet");
        expect(markup).toContain("Checked once it starts");
        expect(markup).toContain("cannot be checked");
    });

    it("keeps a proven port proven while its server is stopped", () => {
        const off: GamePortsReading = {
            ...reading,
            servers: reading.servers.map((server) => ({ ...server, confirmed: true, running: false })),
            advice: gameReachAdvice("home-nat", [], true, "192.168.1.142", "range", DEFAULT_PORT_BLOCKS, null)
        };
        const markup = markupFor(off);

        expect(markup).toContain("Reached from outside");
        expect(markup).not.toContain("Checked once it starts");
    });

    it("has nothing to open once every port has answered", () => {
        const done: GamePortsReading = {
            ...reading,
            servers: reading.servers.map((server) => ({ ...server, confirmed: true })),
            advice: gameReachAdvice("home-nat", pending, true, "192.168.1.142", "range", DEFAULT_PORT_BLOCKS, true)
        };
        const markup = markupFor(done);

        expect(markup).not.toContain("Not confirmed");
        expect(markup).not.toContain("If it is not open yet");
    });
});
