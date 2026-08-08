/**
 * The game-ports section of the Domains panel.
 *
 * It is read by someone with their router open in the other window, so the two
 * things it must never do are paint nothing while it waits for its own first poll,
 * and print a rule the form in front of them will refuse. Both are asserted from
 * the markup the server hands over.
 *
 * Rendered to static markup: the poll itself belongs to `useLiveResource`, which
 * has no part in what the first paint says.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_PORT_BLOCKS } from "../../src/lib/apps/port-block";
import type { GamePortsReading } from "../../src/lib/apps/games-service";
import { gameReachAdvice } from "../../src/lib/apps/minecraft/reach-advice";
import { GamePortsLive } from "../../src/app/(app)/admin/domains/game-ports-live";

const pending = [{ port: 25565, protocol: "tcp" as const }];

const reading: GamePortsReading = {
    servers: [
        { installedAppId: "one", name: "Survival", ports: pending, confirmed: false },
        { installedAppId: "two", name: "Creative", ports: [{ port: 25566, protocol: "tcp" }], confirmed: true }
    ],
    advice: gameReachAdvice("home-nat", pending, false, "192.168.1.142", "range", DEFAULT_PORT_BLOCKS),
    lanIp: "192.168.1.142",
    policy: "range",
    blocks: DEFAULT_PORT_BLOCKS
};

describe("the game ports section", () => {
    it("paints the servers it was handed rather than waiting for its own read", () => {
        const markup = renderToStaticMarkup(<GamePortsLive initial={reading} />);

        expect(markup).toContain("Survival");
        expect(markup).toContain("Not confirmed");
        expect(markup).toContain("Reached from outside");
    });

    it("says what is still in the way, for the servers that are not proven", () => {
        const markup = renderToStaticMarkup(<GamePortsLive initial={reading} />);

        expect(markup).toContain("has to be forwarded on your router");
        // The range policy asks for the block, not the one port in use today.
        expect(markup).toContain("25565-25664");
    });

    it("has nothing to open once every port has answered", () => {
        const done: GamePortsReading = {
            ...reading,
            servers: reading.servers.map((server) => ({ ...server, confirmed: true })),
            advice: gameReachAdvice("home-nat", pending, true, "192.168.1.142", "range", DEFAULT_PORT_BLOCKS)
        };
        const markup = renderToStaticMarkup(<GamePortsLive initial={done} />);

        expect(markup).not.toContain("Not confirmed");
        expect(markup).not.toContain("has to be forwarded on your router");
    });
});
