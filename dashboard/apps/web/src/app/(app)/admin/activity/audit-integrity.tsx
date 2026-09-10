"use client";

/**
 * Whether the audit trail is intact.
 *
 * One line when all is well - how much is sealed, when the chain was last
 * checked, and the head to keep somewhere else - and a warning that says which
 * entry broke and how when it is not. The check itself runs daily on its own;
 * the button is for needing the answer now.
 */

import * as core from "@polaris/core";
import { useTransition } from "react";
import { verifyAuditChainAction } from "./actions";
import type { ChainStatus } from "@/lib/audit-chain";
import { Button, Skeleton, useToast } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import { Copy, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

/** Re-read gently: the backlog shrinks over minutes, not seconds. */
const POLL_MS = 60_000;

export function AuditIntegrity() {
    const format = useDisplayFormat();
    const toast = useToast();
    const [checking, startChecking] = useTransition();
    const { data, loading, refresh } = useLiveResource<ChainStatus>({
        url: "/api/admin/activity/integrity",
        cacheKey: "admin.activity.integrity",
        intervalMs: POLL_MS,
        select: (body) => body as ChainStatus
    });

    const verify = () =>
        startChecking(async () => {
            const outcome = await verifyAuditChainAction();
            if (outcome.error) toast.show({ title: outcome.error });
            else if (outcome.result?.ok)
                toast.show({ title: `Chain intact across ${outcome.result.checked} entries.` });
            else toast.show({ title: "The chain is broken. The panel says where." });
            refresh();
        });

    if (loading || !data) {
        return <Skeleton className="h-14 w-full rounded-lg" />;
    }

    const last = data.lastVerification;
    const broken = last && !last.ok ? last.broken : null;
    const Icon = broken ? ShieldAlert : ShieldCheck;

    return (
        <div
            className={
                broken
                    ? "flex flex-wrap items-center gap-3 rounded-lg border border-danger-edge bg-danger-soft px-3 py-2.5 text-sm"
                    : "flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm"
            }
        >
            <Icon
                className={broken ? "size-4 shrink-0 text-danger" : "size-4 shrink-0 text-success"}
                aria-hidden
            />
            <div className="min-w-0 flex-1">
                {broken ? (
                    <p className="font-medium text-danger">
                        {core.AUDIT_CHAIN_BREAK_LABELS[broken.reason]} at entry {broken.seq}
                        {broken.entryAt ? `, recorded ${format.dateTime(broken.entryAt)}` : ""}.
                    </p>
                ) : (
                    <p>
                        {data.sealed} entries sealed
                        {data.pending > 0 ? `, ${data.pending} waiting to be` : ""}.{" "}
                        <span className="text-muted-foreground">
                            {last
                                ? `Last checked ${format.dateTime(last.at)}.`
                                : "Not checked yet."}
                        </span>
                    </p>
                )}
                {data.head ? (
                    <p
                        className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
                        title={data.head.hash}
                    >
                        Head #{data.head.seq} {data.head.hash.slice(0, 16)}
                    </p>
                ) : null}
            </div>
            {data.head ? (
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Copy the chain head"
                    title="Copy the chain head, to keep outside Polaris"
                    onClick={() => {
                        void navigator.clipboard
                            .writeText(`${data.head?.seq} ${data.head?.hash}`)
                            .then(() => toast.show({ title: "Chain head copied." }));
                    }}
                >
                    <Copy className="size-4" aria-hidden />
                </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={verify} disabled={checking}>
                {checking ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                {checking ? "Checking" : "Check now"}
            </Button>
        </div>
    );
}
