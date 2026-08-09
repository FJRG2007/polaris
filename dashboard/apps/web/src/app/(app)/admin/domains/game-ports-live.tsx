"use client";

/**
 * The game ports as they stand right now, kept current while the page is open.
 *
 * The operator is in their router while they read this. Everything they are about
 * to do happens in another window, and the only thing that tells them it worked is
 * this card - so it re-reads on its own and knocks on the ports as it goes, rather
 * than holding "not confirmed" until somebody reloads or a player joins by luck.
 *
 * The reading itself belongs to the card above, which is the thing that decides
 * whether there is a card at all: one read, one poll, and a refresh that fails
 * leaves the last answer on screen with a note rather than emptying the card.
 */

import { RefreshCw } from "lucide-react";
import { Badge, Button } from "@polaris/ui";
import { RouterSteps } from "./router-steps";
import { inBlock } from "@/lib/apps/port-block";
import { gameForwardRules } from "@/lib/router-guide";
import type { GamePortsReading } from "@/lib/apps/games-service";
import { describePorts } from "@/lib/apps/minecraft/reach-advice";

export function GamePortsLive({
    reading,
    stale,
    refreshing,
    onRefresh
}: {
    reading: GamePortsReading;
    /** Why the ports on screen stopped updating, when a refresh failed over them. */
    stale: string | null;
    refreshing: boolean;
    onRefresh: () => void;
}) {
    const { servers, advice, lanIp, policy, blocks } = reading;
    const pending = servers.filter((server) => !server.confirmed);
    // A server whose port predates the block is one the range rule does not cover,
    // and it is worth saying which: the operator would otherwise forward the range,
    // see this server still unreachable, and have nothing to go on.
    const outside = servers.filter((server) => server.ports.some((port) => !inBlock(port.port, blocks[port.protocol])));

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    {stale ??
                        "Checked while this page is open: a port is ticked as soon as it answers from outside, or as soon as somebody joins on it."}
                </p>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={onRefresh}
                    disabled={refreshing}
                    aria-label="Check the ports now"
                    title="Check the ports now"
                >
                    <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
                </Button>
            </div>

            <ul className="flex flex-col divide-y divide-border/60">
                {servers.map((server) => (
                    <li key={server.installedAppId} className="flex items-center gap-2 py-2">
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm" title={server.name}>
                                {server.name}
                            </p>
                            <p className="font-mono text-xs text-muted-foreground">{describePorts(server.ports)}</p>
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
                            <RouterSteps server={null} lanIp={lanIp} rules={gameForwardRules(pending, policy, blocks)} />
                        </div>
                    )}
                </div>
            )}

            {policy === "range" && outside.length > 0 && (
                <p className="text-xs text-muted-foreground">
                    {outside.length === 1 ? "One server answers" : `${outside.length} servers answer`} outside those
                    ranges - {outside.map((server) => server.name).join(", ")} - so{" "}
                    {outside.length === 1 ? "it" : "they"} {outside.length === 1 ? "keeps" : "keep"} a rule of their own
                    above. Widening a range does not move a server that is already running; recreating it does.
                </p>
            )}
        </div>
    );
}
