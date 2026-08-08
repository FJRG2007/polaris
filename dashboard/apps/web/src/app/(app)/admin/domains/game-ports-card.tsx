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
 * The card itself renders what is already known and nothing more - the knocking is
 * the live half, and it happens under `GamePortsLive` where waiting on a router
 * costs nobody the page.
 */

import { Card, CardBody } from "@polaris/ui";
import { GamePortsLive } from "./game-ports-live";
import { PortPolicyForm } from "./port-policy-form";
import { describeBlock } from "@/lib/apps/port-block";
import { readGamePorts } from "@/lib/apps/games-service";

export async function GamePortsCard() {
    const reading = await readGamePorts().catch(() => null);
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

                <PortPolicyForm policy={reading.policy} blocks={reading.blocks} />

                <GamePortsLive initial={reading} />
            </CardBody>
        </Card>
    );
}
