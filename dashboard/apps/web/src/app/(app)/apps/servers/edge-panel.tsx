"use client";

/**
 * Whether this server can serve the domains pointed at it.
 *
 * The question behind the panel is one nobody should have to hold in their head:
 * **if Polaris is switched off right now, does the site on this server keep
 * answering?** For a server with its own edge the answer is yes, and that is the
 * whole reason Polaris installs one rather than routing everything through
 * itself - a control plane at the end of somebody's home broadband must not be
 * what a data-centre app depends on.
 *
 * It is a live question and not a stored one, so it is asked when the panel is
 * drawn rather than by the page: opening a connection to a machine that might be
 * asleep is not something a navigation should wait for.
 *
 * The one honest warning is on the button. Preparing replaces the Traefik
 * container, so a server that is already serving stops for the second or two that
 * takes; the operator is the person who knows whether now is a good time, so they
 * are told rather than surprised.
 */

import { Button, cn } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { useCallback, useEffect, useState } from "react";
import type { ServerEdgeState } from "@/lib/deploy/server-edge";
import { prepareServerEdgeAction, serverEdgeAction } from "./actions";
import { CircleAlert, CircleCheck, Loader2, RefreshCw } from "lucide-react";

export function EdgePanel({ hostId }: { hostId: string }) {
    const [state, setState] = useState<ServerEdgeState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [log, setLog] = useState("");

    const ask = useCallback(async () => {
        const answer = await serverEdgeAction(hostId).catch(() => null);
        if (answer) setState(answer);
    }, [hostId]);

    useEffect(() => {
        void ask();
    }, [ask]);

    const prepare = async () => {
        setBusy(true);
        setError("");
        setLog("");
        const result = await runAction(() => prepareServerEdgeAction(hostId), setError);
        setBusy(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setLog(result.log ?? "");
        await ask();
    };

    const ready = state?.traefik === true && state.pushable;

    return (
        <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Serving its own domains</h2>

            {state === null ? (
                <p className="text-sm text-muted-foreground">Asking this server what it is running...</p>
            ) : state.error ? (
                <p className="text-sm text-muted-foreground">
                    Polaris could not ask it: {state.error}
                </p>
            ) : (
                <div className="flex flex-col gap-1.5 rounded-md border border-border p-3">
                    <Line
                        good={state.traefik}
                        yes="It answers on 80 and 443 itself, so a domain pointed here keeps working while Polaris is off."
                        no="Nothing here is answering on 80 and 443, so a domain pointed at this server reaches nothing."
                    />
                    <Line
                        good={state.guard}
                        yes="The firewall's decision-maker is running beside it."
                        no="No firewall decision-maker: an address allowlist still applies, a denylist, a rule pack or a sign-in rule cannot."
                    />
                    <Line
                        good={state.pushable}
                        yes="It takes routes and firewall changes from Polaris as they happen."
                        no="It only reads what a deployed container tells it, so a new domain or an edited firewall rule waits for that service to be built again."
                    />
                </div>
            )}

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error}
                </p>
            )}

            {log && (
                <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-[0.6875rem] leading-relaxed">
                    {log.trim()}
                </pre>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant={ready ? "outline" : "primary"} disabled={busy} onClick={() => void prepare()}>
                    {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <RefreshCw className="size-4 shrink-0" />}
                    {busy ? "Setting it up" : ready ? "Set it up again" : "Set this server up"}
                </Button>
                <span className="text-xs text-muted-foreground">
                    Installs Docker if it is missing, and starts this server&apos;s own edge. It
                    replaces the running one, so anything this server is serving stops for a second
                    or two.
                </span>
            </div>
        </section>
    );
}

/** One thing that is either true of this server or is not, said as what it means
 *  rather than as the name of a container. */
function Line({ good, yes, no }: { good: boolean; yes: string; no: string }) {
    const Icon = good ? CircleCheck : CircleAlert;
    return (
        <p className="flex items-start gap-2 text-xs">
            <Icon className={cn("mt-0.5 size-3.5 shrink-0", good ? "text-success" : "text-warning")} aria-hidden />
            <span className={good ? "text-muted-foreground" : "text-foreground"}>{good ? yes : no}</span>
        </p>
    );
}
