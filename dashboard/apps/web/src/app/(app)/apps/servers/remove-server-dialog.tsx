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
import { useTranslations } from "@/components/i18n/i18n-provider";

/** The ways to remove a server, in the order they are offered; each one's words
 *  are `remove.modes.<mode>` in the `servers` catalog. */
const MODES: readonly ServerRemovalMode[] = ["disconnect", "clean", "move"];

export function RemoveServerDialog({
    server,
    onClose,
    onRemoved
}: {
    server: { id: string; name: string } | null;
    onClose: () => void;
    onRemoved: (result: RemoveServerResult) => void;
}) {
    const t = useTranslations("servers");
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
                        ? t("remove.partlyMoved", { reason: result.error, names: result.moved.join(", ") })
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
    const choices = MODES.filter((one) => one !== "move" || canMove).map((one) => ({
        mode: one,
        label: t(`remove.modes.${one}.label`),
        summary: t(`remove.modes.${one}.summary`)
    }));

    return (
        <ConfirmDeleteDialog
            open={server !== null}
            onOpenChange={(open) => !open && !pending && onClose()}
            name={server?.name ?? ""}
            kind={t("remove.kind")}
            confirmLabel={t(`remove.modes.${mode}.confirm`)}
            description={t("remove.intro")}
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
                        <span className="text-xs text-muted-foreground">{t("remove.moveTo")}</span>
                        <Select
                            value={destination}
                            onValueChange={setDestination}
                            disabled={pending}
                            options={plan.destinations.map((entry) => ({ value: entry.id, label: entry.name }))}
                        />
                        {plan.localVolumes > 0 ? (
                            <span className="text-xs text-warning">
                                {t("remove.volumes", { count: plan.localVolumes })}
                            </span>
                        ) : null}
                    </label>
                ) : null}

                {pending && mode === "move" ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        {t("remove.moving")}
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
    const t = useTranslations("servers");
    if (services === 0 && plan.runnerPools === 0) {
        return (
            <p className="flex items-start gap-2 rounded-md border border-border bg-surface/60 px-3 py-2 text-xs text-muted-foreground">
                <Server className="mt-0.5 size-3.5 shrink-0" />
                {t("remove.nothing")}
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
            <p className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span>
                    {services > 0 ? t("remove.services", { count: services, running }) : null}{" "}
                    {plan.runnerPools > 0 ? t("remove.pools", { count: plan.runnerPools }) : null}
                </span>
            </p>
            {plan.services.length > 0 ? (
                <p className="pl-6 text-foreground/70">
                    {plan.services
                        .slice(0, 6)
                        .map((service) => `${service.project}/${service.name}`)
                        .join(", ")}
                    {plan.services.length > 6 ? t("remove.andMore", { count: plan.services.length - 6 }) : ""}
                </p>
            ) : null}
        </div>
    );
}
