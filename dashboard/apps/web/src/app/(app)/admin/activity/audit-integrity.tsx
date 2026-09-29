"use client";

/**
 * Whether the audit trail is intact.
 *
 * One line when all is well - how much is sealed, when the chain was last
 * checked, and the head to keep somewhere else - and a warning that says which
 * entry broke and how when it is not. The check itself runs daily on its own;
 * the button is for needing the answer now.
 */

import { useTransition } from "react";
import { verifyAuditChainAction } from "./actions";
import type { ChainStatus } from "@/lib/audit-chain";
import { Button, Skeleton, useToast } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Copy, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

/** Re-read gently: the backlog shrinks over minutes, not seconds. */
const POLL_MS = 60_000;

export function AuditIntegrity() {
    const t = useTranslations("admin");
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
            else if (outcome.result?.ok) {
                const checked = outcome.result.checked;
                toast.show({ title: t("activity.integrity.intact", { count: checked, shown: String(checked) }) });
            } else toast.show({ title: t("activity.integrity.brokenToast") });
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
            <Icon className={broken ? "size-4 shrink-0 text-danger" : "size-4 shrink-0 text-success"} aria-hidden />
            <div className="min-w-0 flex-1">
                {broken ? (
                    <p className="font-medium text-danger">
                        {t("activity.integrity.broken", {
                            reason: broken.reason,
                            seq: String(broken.seq),
                            recorded: broken.entryAt ? "yes" : "no",
                            at: broken.entryAt ? format.dateTime(broken.entryAt) : ""
                        })}
                    </p>
                ) : (
                    <p>
                        {t("activity.integrity.sealed", {
                            sealed: data.sealed,
                            sealedShown: String(data.sealed),
                            waiting: data.pending > 0 ? "yes" : "no",
                            pending: String(data.pending)
                        })}{" "}
                        <span className="text-muted-foreground">
                            {last
                                ? t("activity.integrity.lastChecked", { when: format.dateTime(last.at) })
                                : t("activity.integrity.notChecked")}
                        </span>
                    </p>
                )}
                {data.head ? (
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={data.head.hash}>
                        {t("activity.integrity.head", {
                            seq: String(data.head.seq),
                            hash: data.head.hash.slice(0, 16)
                        })}
                    </p>
                ) : null}
            </div>
            {data.head ? (
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("activity.integrity.copyLabel")}
                    title={t("activity.integrity.copyTitle")}
                    onClick={() => {
                        void navigator.clipboard
                            .writeText(`${data.head?.seq} ${data.head?.hash}`)
                            .then(() => toast.show({ title: t("activity.integrity.copied") }));
                    }}
                >
                    <Copy className="size-4" aria-hidden />
                </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={verify} disabled={checking}>
                {checking ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                {checking ? t("activity.integrity.checking") : t("activity.integrity.check")}
            </Button>
        </div>
    );
}
