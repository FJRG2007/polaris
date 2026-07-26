"use client";

/**
 * Ask where a server lives. Each option states how a domain reaches a server like
 * that, so the answer is made for the right reason; picking one saves immediately
 * (no separate save step) and the current value is marked.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import type { ServerEnvironment } from "@polaris/core";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";
import { setServerEnvironmentAction } from "./actions";
import { ENVIRONMENT_CHOICES, ENVIRONMENT_META } from "./environment-meta";

export interface EnvironmentTarget {
    /** Null for the box Polaris runs on, which has no Host row. */
    hostId: string | null;
    name: string;
    current: ServerEnvironment;
    /** Polaris's own guess, surfaced while there is no answer yet. */
    suggested: ServerEnvironment;
    confirmed: boolean;
}

export function EnvironmentDialog({
    target,
    onClose
}: {
    target: EnvironmentTarget | null;
    onClose: () => void;
}) {
    const router = useRouter();
    const [pending, setPending] = useState<ServerEnvironment | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function pick(environment: ServerEnvironment) {
        if (!target) return;
        setPending(environment);
        setError(null);
        const result = await setServerEnvironmentAction({ hostId: target.hostId, environment });
        setPending(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        onClose();
        router.refresh();
    }

    // Only worth showing while unanswered: once confirmed, the marked option says it all.
    const suggestion =
        target && !target.confirmed && target.suggested !== "unknown"
            ? ENVIRONMENT_META[target.suggested].label
            : null;

    return (
        <Dialog open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Where does {target?.name} live?</DialogTitle>
                    <DialogDescription>
                        This decides how a domain can be pointed at it, and whether it can serve public traffic
                        directly.
                    </DialogDescription>
                </DialogHeader>
                {suggestion ? (
                    <p className="mb-3 text-xs text-muted-foreground">
                        Polaris detected <b className="font-medium text-foreground">{suggestion}</b> from its address.
                        Confirm it or pick another.
                    </p>
                ) : null}
                <div className="flex flex-col gap-2">
                    {ENVIRONMENT_CHOICES.map((environment) => {
                        const meta = ENVIRONMENT_META[environment];
                        const selected = target?.current === environment;
                        return (
                            <button
                                key={environment}
                                type="button"
                                onClick={() => pick(environment)}
                                disabled={pending !== null}
                                className={`flex flex-col gap-1 rounded-md border p-3 text-left transition-colors disabled:opacity-60 ${
                                    selected
                                        ? "border-primary bg-primary/5"
                                        : "border-border hover:border-primary/40 hover:bg-card-hover"
                                }`}
                            >
                                <span className="flex items-center gap-2 text-sm font-medium">
                                    {meta.label}
                                    {selected ? <Check className="size-3.5 text-primary" /> : null}
                                    {pending === environment ? (
                                        <span className="text-xs font-normal text-muted-foreground">Saving...</span>
                                    ) : null}
                                </span>
                                <span className="text-xs text-muted-foreground">{meta.summary}</span>
                                <span className="text-xs text-foreground/70">{meta.routing}</span>
                            </button>
                        );
                    })}
                </div>
                {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
            </DialogContent>
        </Dialog>
    );
}
