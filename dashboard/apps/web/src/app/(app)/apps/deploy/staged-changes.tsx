"use client";

/**
 * The changeset banner: what is waiting to happen, and the button that makes it
 * happen.
 *
 * Removing a service does not remove it - it lands here first, drawn in the same
 * violet the canvas uses for a pending node, and stays until somebody deploys the
 * changeset. That gap is the whole point: it is where an operator notices they
 * were looking at production.
 *
 * Applying is reported honestly. Each change tears down real infrastructure, so a
 * run can half-succeed - what worked is gone, what did not is still listed with
 * the reason, and pressing deploy again retries only that.
 */

import { useRouter } from "next/navigation";
import { STAGED_CHANGE_LABELS } from "@polaris/core";
import type { ShellEnvironment } from "./project-shell";
import type { StagedChangeView } from "@/lib/deploy-staged-changes";
import { Database, HardDrive, Layers, Loader2, Rocket, Trash2, TriangleAlert, X } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import {
    applyStagedChangesAction,
    discardAllStagedChangesAction,
    discardStagedChangeAction,
    listStagedChangesAction
} from "./project-actions";

/**
 * The changeset, held on the client.
 *
 * It is seeded from the server so the first paint is right, and then owned here.
 * The banner lives in the project's layout while the canvas lives in the page,
 * and a server round trip does not reliably refresh both - so staging a removal
 * would update one and leave the other showing the state from before. One
 * context, refreshed by whoever changed it, keeps them in step.
 */
const StagedChangesContext = createContext<{
    changes: StagedChangeView[];
    refresh: () => void;
}>({ changes: [], refresh: () => undefined });

export function useStagedChanges() {
    return useContext(StagedChangesContext);
}

export function StagedChangesProvider({
    projectId,
    initial,
    children
}: {
    projectId: string;
    initial: StagedChangeView[];
    children: ReactNode;
}) {
    const [changes, setChanges] = useState(initial);

    // A server render that arrives with different data wins: it is the fresher
    // of the two whenever the page itself was just re-fetched.
    useEffect(() => {
        setChanges(initial);
    }, [initial]);

    const refresh = useCallback(() => {
        void listStagedChangesAction(projectId).then((result) => {
            if (result.changes) setChanges(result.changes);
        });
    }, [projectId]);

    const value = useMemo(() => ({ changes, refresh }), [changes, refresh]);
    return <StagedChangesContext.Provider value={value}>{children}</StagedChangesContext.Provider>;
}

function ChangeIcon({ targetType }: { targetType: string }) {
    if (targetType === "volume") return <HardDrive className="size-4 shrink-0 text-muted-foreground" />;
    if (targetType === "database") return <Database className="size-4 shrink-0 text-muted-foreground" />;
    return <Layers className="size-4 shrink-0 text-muted-foreground" />;
}

export function StagedChangesBanner({
    projectId,
    environmentId,
    environments
}: {
    projectId: string;
    /** The environment currently on screen - the one Deploy acts on. */
    environmentId: string;
    environments: ShellEnvironment[];
}) {
    const { changes, refresh: refreshChanges } = useStagedChanges();
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [failures, setFailures] = useState<{ targetName: string; error: string }[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    if (changes.length === 0) return null;

    const here = changes.filter((change) => change.environmentId === environmentId);
    const elsewhere = changes.length - here.length;

    function apply() {
        setError(null);
        setFailures([]);
        startTransition(async () => {
            const result = await applyStagedChangesAction({ projectId, environmentId });
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.failures && result.failures.length > 0) {
                setFailures(result.failures);
                refreshChanges();
                router.refresh();
                return;
            }
            setOpen(false);
            refreshChanges();
            router.refresh();
        });
    }

    function discard(id: string) {
        startTransition(async () => {
            const result = await discardStagedChangeAction({ projectId, id });
            if (result.error) setError(result.error);
            refreshChanges();
            router.refresh();
        });
    }

    function discardAll() {
        startTransition(async () => {
            const result = await discardAllStagedChangesAction({ projectId, environmentId });
            if (result.error) setError(result.error);
            else setOpen(false);
            refreshChanges();
            router.refresh();
        });
    }

    const count = here.length;
    const summary =
        count === 0
            ? `${elsewhere} pending ${elsewhere === 1 ? "change" : "changes"} in another environment`
            : `${count} pending ${count === 1 ? "change" : "changes"}`;

    return (
        <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                    <span className="relative flex size-2 shrink-0">
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
                        <span className="relative inline-flex size-2 rounded-full bg-primary" />
                    </span>
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{summary}</p>
                        <p className="truncate text-xs text-muted-foreground">
                            {count === 0
                                ? "Switch to that environment to review and deploy them."
                                : "Nothing has been removed yet. Review the changeset, then deploy it."}
                        </p>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
                        Details
                    </Button>
                    <Button size="sm" disabled={pending || count === 0} onClick={apply}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
                        Deploy
                    </Button>
                </div>
            </div>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Pending changes</DialogTitle>
                        <DialogDescription>
                            These take effect when you deploy. Discard any you did not mean.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-3">
                        <ul className="max-h-72 overflow-y-auto rounded-md border border-border/60">
                            {changes.map((change) => {
                                const environment = environments.find((entry) => entry.id === change.environmentId);
                                const foreign = change.environmentId !== environmentId;
                                return (
                                    <li
                                        key={change.id}
                                        className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-0"
                                    >
                                        <div className="flex min-w-0 items-center gap-2">
                                            <ChangeIcon targetType={change.targetType} />
                                            <div className="min-w-0">
                                                <p className="truncate text-sm">
                                                    <span className="text-danger">
                                                        {STAGED_CHANGE_LABELS[change.kind] ?? change.kind}
                                                    </span>{" "}
                                                    <span className="font-medium">{change.targetName}</span>
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    {[environment?.name, change.detail].filter(Boolean).join(" - ")}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">
                                            {foreign && (
                                                <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                                                    Other environment
                                                </span>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => discard(change.id)}
                                                disabled={pending}
                                                aria-label={`Discard removing ${change.targetName}`}
                                                title="Discard"
                                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                            >
                                                <X className="size-4" />
                                            </button>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>

                        {failures.length > 0 && (
                            <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
                                <p className="flex items-center gap-1.5 text-sm font-medium text-danger">
                                    <TriangleAlert className="size-4" />
                                    Some changes could not be applied
                                </p>
                                <ul className="mt-1 flex flex-col gap-0.5">
                                    {failures.map((failure) => (
                                        <li key={failure.targetName} className="text-xs text-muted-foreground">
                                            <span className="text-foreground">{failure.targetName}</span>:{" "}
                                            {failure.error}
                                        </li>
                                    ))}
                                </ul>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    They are still pending. Deploying again retries only these.
                                </p>
                            </div>
                        )}

                        {error && <p className="text-sm text-danger">{error}</p>}

                        <div className="flex flex-wrap justify-end gap-2">
                            <Button variant="ghost" size="sm" disabled={pending || here.length === 0} onClick={discardAll}>
                                <Trash2 className="size-4" /> Discard all here
                            </Button>
                            <Button size="sm" disabled={pending || here.length === 0} onClick={apply}>
                                {pending ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
                                Deploy {here.length > 0 ? here.length : ""}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
