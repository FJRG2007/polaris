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
 * shows what is confirmed apart from what is not: a port is only ticked once
 * somebody has actually joined on it from a public address, which is the one piece
 * of evidence a router cannot fake.
 */

import { RouterSteps } from "./router-steps";
import { getHostLanIp } from "@/lib/host-address";
import { Badge, Card, CardBody } from "@polaris/ui";
import { gameForwardRules } from "@/lib/router-guide";
import { listGamePorts } from "@/lib/apps/games-service";
import { getLocalEnvironment } from "@/lib/network-service";
import { describePorts, gameReachAdvice } from "@/lib/apps/minecraft/reach";

export async function GamePortsCard() {
    const servers = await listGamePorts().catch(() => []);
    // Nothing to say on a deployment that runs no game servers, and a card that
    // explains a situation nobody is in is noise on an admin page.
    if (servers.length === 0) return null;

    const [{ environment }, lanIp] = await Promise.all([
        getLocalEnvironment().catch(() => ({ environment: "unknown" as const })),
        getHostLanIp().catch(() => null)
    ]);

    const pending = servers.filter((server) => !server.confirmed);
    const advice = gameReachAdvice(
        environment,
        pending.flatMap((server) => server.ports),
        pending.length === 0,
        lanIp
    );

    return (
        <Card id="game-ports" className="scroll-mt-4">
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">Game server ports</p>
                    <p className="text-xs text-muted-foreground">
                        Ports 80 and 443 carry every website Polaris serves and not one game client. Each server below
                        answers on its own port, on its own transport, and nothing above this opens them.
                    </p>
                </div>

                <ul className="flex flex-col divide-y divide-border/60">
                    {servers.map((server) => (
                        <li key={server.installedAppId} className="flex items-center gap-2 py-2">
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm" title={server.name}>
                                    {server.name}
                                </p>
                                <p className="font-mono text-xs text-muted-foreground">
                                    {describePorts(server.ports)}
                                </p>
                            </div>
                            {server.confirmed ? (
                                <Badge className="border-success/40 text-success">Reached from outside</Badge>
                            ) : (
                                <Badge className="border-warning/40 text-warning">Not confirmed</Badge>
                            )}
                        </li>
                    ))}
                </ul>

                {pending.length > 0 && (
                    <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                        <p className="font-medium text-foreground">{advice.title}</p>
                        <p className="text-muted-foreground">{advice.detail}</p>
                        {advice.steps.length > 0 && (
                            <ul className="ml-4 list-disc text-muted-foreground">
                                {advice.steps.map((step) => (
                                    <li key={step}>{step}</li>
                                ))}
                            </ul>
                        )}
                        {advice.forward && (
                            <div className="text-muted-foreground">
                                <RouterSteps server={null} lanIp={lanIp} rules={gameForwardRules(pending)} />
                            </div>
                        )}
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
