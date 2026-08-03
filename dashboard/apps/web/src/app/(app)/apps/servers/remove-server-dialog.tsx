"use client";

/**
 * Removing a server, with the machine itself taken into account.
 *
 * The dangerous part of this is not the deletion, it is what stays behind: a
 * server that is forgotten keeps running the services Polaris put there, with
 * nothing left that knows about them. So the choice comes first and is spelled
 * out in what it does to the machine, the inventory is loaded before anything is
 * confirmed (a server carrying five services should not read the same as an empty
 * one), and the name still has to be typed - this is the one screen where being
 * wrong costs somebody else's uptime.
 */

import { useEffect, useState, useTransition } from "react";
import { ConfirmDeleteDialog, Select, Skeleton } from "@polaris/ui";
import { Check, Loader2, Server, TriangleAlert } from "lucide-react";
import { removeServerAction, serverRemovalPlanAction } from "./actions";
import type { RemoveServerResult, ServerRemovalMode, ServerRemovalPlan } from "@/lib/server-removal-service";

interface Choice {
    readonly mode: ServerRemovalMode;
    readonly label: string;
    readonly summary: string;
    readonly confirmLabel: string;
}

const CHOICES: readonly Choice[] = [
    {
        mode: "disconnect",
        label: "Disconnect it",
        summary:
            "Polaris forgets the server and stops managing it. Whatever is running there keeps running, and its login stays authorized.",
        confirmLabel: "Disconnect server"
    },
    {
        mode: "clean",
        label: "Disconnect it and clean up",
        summary:
            "Stop the services Polaris deployed there and take its login back off the machine first, so nothing is left running unmanaged.",
        confirmLabel: "Clean up and disconnect"
    },
    {
        mode: "move",
        label: "Move its services first, then clean up",
        summary:
            "Each service comes up on the new server before the old one is stopped, so it is not off while it moves. Then the machine is cleaned up and forgotten.",
        confirmLabel: "Move and disconnect"
    }
];

export function RemoveServerDialog({
    server,
    onClose,
    onRemoved
}: {
    server: { id: string; name: string } | null;
    onClose: () => void;
    onRemoved: (result: RemoveServerResult) => void;
}) {
    const [plan, setPlan] = useState<ServerRemovalPlan | null>(null);
    const [mode, setMode] = useState<ServerRemovalMode>("clean");
    const [destination, setDestination] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // Load what the removal would affect. Re-run per server, and reset the choice
    // with it: a mode picked for one machine is not an answer about another.
    useEffect(() => {
        setPlan(null);
        setMode("clean");
        setDestination("");
        setError(null);
        if (!server) return;
        let current = true;
        void serverRemovalPlanAction(server.id).then((result) => {
            if (!current) return;
            setPlan(result);
            setDestination(result?.destinations[0]?.id ?? "");
        });
        return () => {
            current = false;
        };
    }, [server]);

    function remove() {
        if (!server) return;
        setError(null);
        startTransition(async () => {
            const result = await removeServerAction(server.id, {
                mode,
                destinationId: mode === "move" ? destination : undefined
            });
            if (result.error) {
                setError(
                    result.moved && result.moved.length > 0
                        ? `${result.error}. Moved first: ${result.moved.join(", ")}. The server is still connected.`
                        : result.error
                );
                return;
            }
            onRemoved(result);
            onClose();
        });
    }

    const services = plan?.services ?? [];
    const running = services.filter((service) => service.deployed).length;
    const canMove = (plan?.destinations.length ?? 0) > 0;
    const choices = CHOICES.filter((choice) => choice.mode !== "move" || canMove);

    return (
        <ConfirmDeleteDialog
            open={server !== null}
            onOpenChange={(open) => !open && !pending && onClose()}
            name={server?.name ?? ""}
            kind="server"
            confirmLabel={CHOICES.find((choice) => choice.mode === mode)?.confirmLabel}
            description="Polaris stops reaching this machine. What happens to what it is running is up to you."
            error={error}
            pending={pending}
            onConfirm={remove}
        >
            <div className="flex flex-col gap-3">
                {plan === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : (
                    <Inventory plan={plan} services={services.length} running={running} />
                )}

                <div className="flex flex-col gap-2">
                    {choices.map((choice) => (
                        <button
                            key={choice.mode}
                            type="button"
                            onClick={() => setMode(choice.mode)}
                            disabled={pending}
                            className={`flex flex-col gap-1 rounded-md border p-3 text-left transition-colors disabled:opacity-60 ${
                                mode === choice.mode
                                    ? "border-primary bg-primary/5"
                                    : "border-border hover:border-primary/40 hover:bg-card-hover"
                            }`}
                        >
                            <span className="flex items-center gap-2 text-sm font-medium">
                                {choice.label}
                                {mode === choice.mode ? <Check className="size-3.5 text-primary" /> : null}
                            </span>
                            <span className="text-xs text-muted-foreground">{choice.summary}</span>
                        </button>
                    ))}
                </div>

                {mode === "move" && plan ? (
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">Move the services to</span>
                        <Select
                            value={destination}
                            onValueChange={setDestination}
                            disabled={pending}
                            options={plan.destinations.map((entry) => ({ value: entry.id, label: entry.name }))}
                        />
                        {plan.localVolumes > 0 ? (
                            <span className="text-xs text-warning">
                                {plan.localVolumes === 1 ? "One volume" : `${plan.localVolumes} volumes`} on this
                                machine {plan.localVolumes === 1 ? "is" : "are"} re-created empty on the new server.
                                Copy anything you need off it first.
                            </span>
                        ) : null}
                    </label>
                ) : null}

                {pending && mode === "move" ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Moving the services. Each one is a full deploy, so this takes a few minutes - leave this open.
                    </p>
                ) : null}
            </div>
        </ConfirmDeleteDialog>
    );
}

/** What is on the machine, so the choice is made knowing the size of it. */
function Inventory({
    plan,
    services,
    running
}: {
    plan: ServerRemovalPlan;
    services: number;
    running: number;
}) {
    if (services === 0 && plan.runnerPools === 0) {
        return (
            <p className="flex items-start gap-2 rounded-md border border-border bg-surface/60 px-3 py-2 text-xs text-muted-foreground">
                <Server className="mt-0.5 size-3.5 shrink-0" />
                Nothing is deployed on this server.
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            <p className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span>
                    {services > 0 ? (
                        <>
                            {services} {services === 1 ? "service" : "services"} live here
                            {running > 0 ? `, ${running} running right now` : ""}.
                        </>
                    ) : null}{" "}
                    {plan.runnerPools > 0 ? (
                        <>
                            {plan.runnerPools} {plan.runnerPools === 1 ? "runner pool" : "runner pools"} lose the
                            machine they run on.
                        </>
                    ) : null}
                </span>
            </p>
            {plan.services.length > 0 ? (
                <p className="pl-6 text-foreground/70">
                    {plan.services
                        .slice(0, 6)
                        .map((service) => `${service.project}/${service.name}`)
                        .join(", ")}
                    {plan.services.length > 6 ? ` and ${plan.services.length - 6} more` : ""}
                </p>
            ) : null}
        </div>
    );
}
