"use client";

/**
 * Removing a storage connection, with what depends on it taken into account.
 *
 * Browsing is the visible half of a connection; the half that hurts is the
 * services mounting folders on it, which lose their data directory the moment it
 * goes. So the dialog loads what is at stake first, refuses to forget a device
 * something is still mounting, and offers the answer that is usually wanted -
 * copy it all somewhere else and bring the services back up against the copy.
 */

import { useEffect, useState, useTransition } from "react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ConfirmDeleteDialog, Select, Skeleton } from "@polaris/ui";
import { Check, HardDrive, Loader2, TriangleAlert } from "lucide-react";
import { connectionRemovalPlanAction, removeConnectionAction } from "./actions";
import type {
    ConnectionRemovalMode,
    ConnectionRemovalPlan,
    RemoveConnectionResult
} from "@/lib/connection-removal-service";

interface Choice {
    readonly mode: ConnectionRemovalMode;
    readonly label: NamespaceKey<"drive">;
    readonly summary: NamespaceKey<"drive">;
    readonly confirmLabel: NamespaceKey<"drive">;
}

const CHOICES: readonly Choice[] = [
    {
        mode: "forget",
        label: "removeConnection.forget.label",
        summary: "removeConnection.forget.summary",
        confirmLabel: "removeConnection.forget.confirm"
    },
    {
        mode: "move",
        label: "removeConnection.move.label",
        summary: "removeConnection.move.summary",
        confirmLabel: "removeConnection.move.confirm"
    }
];

export function RemoveConnectionDialog({
    connection,
    onClose,
    onRemoved
}: {
    connection: { id: string; name: string } | null;
    onClose: () => void;
    onRemoved: (result: RemoveConnectionResult) => void;
}) {
    const t = useTranslations("drive");
    const [plan, setPlan] = useState<ConnectionRemovalPlan | null>(null);
    const [mode, setMode] = useState<ConnectionRemovalMode>("forget");
    const [destination, setDestination] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        setPlan(null);
        setMode("forget");
        setDestination("");
        setError(null);
        if (!connection) return;
        let current = true;
        void connectionRemovalPlanAction(connection.id).then((result) => {
            if (!current) return;
            setPlan(result);
            setDestination(result?.destinations[0]?.id ?? "");
            // A device something is mounted on cannot simply be forgotten, so the
            // only answer that works is the one already selected when they arrive.
            if (result && result.services.length > 0 && result.destinations.length > 0) setMode("move");
        });
        return () => {
            current = false;
        };
    }, [connection]);

    function remove() {
        if (!connection) return;
        setError(null);
        startTransition(async () => {
            const result = await removeConnectionAction(connection.id, {
                mode,
                destinationId: mode === "move" ? destination : undefined
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            onRemoved(result);
            onClose();
        });
    }

    const canMove = (plan?.destinations.length ?? 0) > 0;
    const choices = CHOICES.filter((choice) => choice.mode !== "move" || canMove);
    const confirmKey = CHOICES.find((choice) => choice.mode === mode)?.confirmLabel;

    return (
        <ConfirmDeleteDialog
            open={connection !== null}
            onOpenChange={(open) => !open && !pending && onClose()}
            name={connection?.name ?? ""}
            kind="connection"
            title={t("removeConnection.title")}
            confirmLabel={confirmKey ? t(confirmKey) : undefined}
            description={t("removeConnection.description")}
            error={error}
            pending={pending}
            onConfirm={remove}
        >
            <div className="flex flex-col gap-3">
                {plan === null ? <Skeleton className="h-16 w-full" /> : <Dependents plan={plan} />}

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
                                {t(choice.label)}
                                {mode === choice.mode ? <Check className="size-3.5 text-primary" /> : null}
                            </span>
                            <span className="text-xs text-muted-foreground">{t(choice.summary)}</span>
                        </button>
                    ))}
                </div>

                {mode === "move" && plan ? (
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">{t("removeConnection.copyTo")}</span>
                        <Select
                            value={destination}
                            onValueChange={setDestination}
                            disabled={pending}
                            options={plan.destinations.map((entry) => ({ value: entry.id, label: entry.name }))}
                        />
                    </label>
                ) : null}

                {pending ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        {mode === "move"
                            ? t("removeConnection.copying")
                            : t("removeConnection.removing")}
                    </p>
                ) : null}
            </div>
        </ConfirmDeleteDialog>
    );
}

/** What else is hanging off this connection, stated before the choice is made. */
function Dependents({ plan }: { plan: ConnectionRemovalPlan }) {
    const t = useTranslations("drive");
    const links = plan.shares + plan.fileRequests;
    if (plan.services.length === 0 && links === 0) {
        return (
            <p className="flex items-start gap-2 rounded-md border border-border bg-surface/60 px-3 py-2 text-xs text-muted-foreground">
                <HardDrive className="mt-0.5 size-3.5 shrink-0" />
                {t("removeConnection.noDependents")}
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
            {plan.services.length > 0 ? (
                <p className="flex items-start gap-2">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span>
                        {t("removeConnection.servicesKeepData", {
                            services: plan.services.map((service) => `${service.name} (${service.volume})`).join(", "),
                            count: plan.services.length
                        })}
                    </span>
                </p>
            ) : null}
            {links > 0 ? (
                <p className="pl-6">
                    {t("removeConnection.linksStop", { count: links })}
                </p>
            ) : null}
        </div>
    );
}
