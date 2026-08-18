"use client";

/**
 * The ports a call needs, and whether they reach this machine.
 *
 * Its own section for the same reason the game ports have one: this page is
 * finished the moment 80 and 443 answer, and those two carry every website
 * Polaris serves and not one second of audio. A deployment can therefore be
 * entirely green here and still drop every call to somebody outside the house -
 * which is invisible from inside the call, where both names appear and neither
 * person hears anything.
 *
 * Only the TCP port can be knocked on; the UDP one answers nothing it cannot
 * attribute to a call already being set up. So the row says which is which
 * rather than reporting silence as a fault, and the rules underneath cover both,
 * because they are one rule each in the same form.
 */

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { RouterSteps } from "./router-steps";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { useLiveResource } from "@/components/use-live-resource";
import { CALL_FORWARD_RULES, type CallPortsReading } from "@/lib/chat/call-ports";

/** How often the card re-reads. The knock behind it is rate limited to one every
 *  thirty seconds, so this is about how soon the answer shows. */
const POLL_MS = 15_000;

const PORTS_URL = "/api/admin/domains/call-ports";

export function CallPortsCard() {
    // Off for the first read and on for every one after: knocking on a closed
    // port waits out a timeout, so the card is on screen before it starts.
    const [url, setUrl] = useState(PORTS_URL);
    const live = useLiveResource<CallPortsReading>({
        url,
        cacheKey: "admin.callPorts",
        intervalMs: POLL_MS,
        select: (body) => body as CallPortsReading
    });

    useEffect(() => {
        if (!live.loading) setUrl(`${PORTS_URL}?probe=1`);
    }, [live.loading]);

    const reading = live.data;
    // Nothing to say about a call server somebody else runs: it has its own
    // address and its own router, and none of this advice is about it.
    if (!reading || !reading.shipped) return null;

    return (
        <Card id="call-ports" className="scroll-mt-4">
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">Call ports</p>
                    <p className="text-xs text-muted-foreground">
                        Setting a call up goes through 443 with everything else. The sound does not:
                        it arrives on the two ports below. Calls between devices on this network
                        already work; calls from outside need these forwarded to this machine.
                    </p>
                </div>

                <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                        {live.stale ??
                            (reading.running
                                ? "Checked while this page is open: the TCP port is ticked as soon as it answers from outside."
                                : "The call server is not answering, so nothing here can be checked yet.")}
                    </p>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={live.refresh}
                        disabled={live.refreshing}
                        aria-label="Check the ports now"
                        title="Check the ports now"
                    >
                        <RefreshCw className={live.refreshing ? "size-4 animate-spin" : "size-4"} />
                    </Button>
                </div>

                <ul className="flex flex-col divide-y divide-border/60">
                    {reading.ports.map((entry) => (
                        <li key={`${entry.protocol}-${entry.port}`} className="flex items-center gap-2 py-2">
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm" title={entry.label}>{entry.label}</p>
                                <p className="font-mono text-xs text-muted-foreground">
                                    {entry.port}/{entry.protocol}
                                </p>
                            </div>
                            {!entry.probeable ? (
                                // Not a verdict. This port answers nothing a
                                // stranger can send it, so calling it "not
                                // confirmed" would put a warning on a port that
                                // is very likely open.
                                <Badge title="Nothing answers an unsolicited packet on this port, so it cannot be checked from here - forward it alongside the other one">
                                    Cannot be checked
                                </Badge>
                            ) : !reading.running ? (
                                // Three states, not two, for the reason the game
                                // ports card has three: a stopped server answers
                                // nothing on any port, so "not confirmed" would
                                // put a warning on a rule that is very likely
                                // right and send somebody into their router.
                                <Badge title="A call server that is not answering is silent on every port, so this cannot be checked from here">
                                    Checked once it answers
                                </Badge>
                            ) : reading.confirmed ? (
                                <Badge
                                    className="border-success/40 text-success"
                                    title={
                                        reading.confirmedAt
                                            ? `Last answered from outside on ${new Date(reading.confirmedAt).toLocaleString()}`
                                            : undefined
                                    }
                                >
                                    Reached from outside
                                </Badge>
                            ) : (
                                <Badge className="border-warning/40 text-warning">Not confirmed</Badge>
                            )}
                        </li>
                    ))}
                </ul>

                {/* Only when the router is the thing in the way. A stopped media
                    server answers nothing on any port, and sending somebody into
                    their router over that is an hour spent on a rule that was
                    already right. */}
                {!reading.running ? (
                    <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                        The call server is not answering, so these ports carry nothing yet and
                        cannot be checked. Chat settings says what it is doing.
                    </p>
                ) : reading.confirmed ? null : (
                    <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                        <p className="font-medium text-foreground">
                            Calls only reach this network so far
                        </p>
                        <p className="text-muted-foreground">
                            {reading.cannotProbe ??
                                "Nothing has arrived on the call ports from outside yet. Forwarding them in the router fixes it, and this ticks itself the moment they work."}
                        </p>
                        <div className="text-muted-foreground">
                            <RouterSteps server={null} lanIp={reading.lanIp} rules={CALL_FORWARD_RULES} />
                        </div>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
