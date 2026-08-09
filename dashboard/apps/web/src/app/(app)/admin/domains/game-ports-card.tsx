"use client";

/**
 * The ports the game servers answer on, and what still has to be opened for them.
 *
 * A section of its own because the rest of this page is finished the moment 80 and
 * 443 reach Polaris - the zone check goes green, the router advice disappears, and
 * a game server sitting on a port nobody ever forwarded is invisible from here.
 * That is the state most deployments are in: websites work, the server says
 * "running", and every player outside the network gets a timeout.
 *
 * So it is driven by the servers themselves rather than by the DNS check, and it
 * shows what is confirmed apart from what is not: a port is ticked once something
 * has actually arrived on it from a public address, which is the one piece of
 * evidence a router cannot fake.
 *
 * It reads in two passes for the same reason it exists at all. The first asks what
 * is already known, which is a database read; every one after it knocks, which
 * waits out a timeout on each port nobody has opened. Rendering this on the server
 * meant the whole page waited for the first of those, so both now happen in the
 * browser and the card appears as soon as there is something in it.
 *
 * Nothing is drawn until that first read answers - not even a skeleton. A
 * deployment that runs no game server has no card here at all, and a placeholder
 * that resolves into nothing is a page that moves under whoever is reading it.
 */

import { useEffect, useState } from "react";
import { Card, CardBody } from "@polaris/ui";
import { GamePortsLive } from "./game-ports-live";
import { PortPolicyForm } from "./port-policy-form";
import { describeBlock } from "@/lib/apps/port-block";
import { useLiveResource } from "@/components/use-live-resource";
import type { GamePortsReading } from "@/lib/apps/games-service";

/** How often the card re-reads. The knock behind it is rate limited to one every
 *  thirty seconds per server, so this is about how soon the answer shows. */
const POLL_MS = 15_000;

const PORTS_URL = "/api/admin/domains/game-ports";

export function GamePortsCard() {
    // Off for the first read and on for every one after: knocking on a closed port
    // waits out a timeout, so the card is on screen before it starts.
    const [url, setUrl] = useState(PORTS_URL);
    const live = useLiveResource<GamePortsReading>({
        url,
        cacheKey: "admin.gamePorts",
        intervalMs: POLL_MS,
        select: (body) => body as GamePortsReading
    });

    useEffect(() => {
        // Once the first read has answered either way. A card that never loaded has
        // nothing to knock for, and would otherwise retry against the slow URL.
        if (!live.loading) setUrl(`${PORTS_URL}?probe=1`);
    }, [live.loading]);

    const reading = live.data;
    // Nothing to say on a deployment that runs no game servers, and a card that
    // explains a situation nobody is in is noise on an admin page.
    if (!reading || reading.servers.length === 0) return null;

    return (
        <Card id="game-ports" className="scroll-mt-4">
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">Game server ports</p>
                    <p className="text-xs text-muted-foreground">
                        Ports 80 and 443 carry every website Polaris serves and not one game client. Each server below
                        answers on its own port, on its own transport, and nothing above this opens them.
                        {reading.policy === "range" ? (
                            <>
                                {" "}
                                Polaris keeps them inside{" "}
                                <span className="font-mono text-foreground">
                                    TCP {describeBlock(reading.blocks.tcp)}
                                </span>{" "}
                                and{" "}
                                <span className="font-mono text-foreground">
                                    UDP {describeBlock(reading.blocks.udp)}
                                </span>
                                , so forwarding those two ranges covers the servers you have and the ones you have not
                                created yet.
                            </>
                        ) : null}
                    </p>
                </div>

                <PortPolicyForm policy={reading.policy} blocks={reading.blocks} onSaved={live.refresh} />

                <GamePortsLive
                    reading={reading}
                    stale={live.stale}
                    refreshing={live.refreshing}
                    onRefresh={live.refresh}
                />
            </CardBody>
        </Card>
    );
}
