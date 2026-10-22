"use client";

/**
 * The access log of one thing that can be lent: who used it, what they did,
 * when, and whether it worked - narrowed to one key or to refusals, and taken
 * away as a CSV. Read from `/api/access/uses`, which asks the same standing
 * the share dialog does.
 */

import { useEffect, useState } from "react";
import { Download, History } from "lucide-react";
import type * as core from "@polaris/core";
import type { GrantUseView } from "@/lib/access/grants";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useDisplayFormat } from "@/components/display-format";
import { Badge, Button, SegmentedControl, Skeleton } from "@polaris/ui";

type Outcome = "all" | "done" | "refused";

const KNOWN_ACTIONS = new Set(["open", "close", "operate", "watch", "command"]);

export function AccessLog({
    subject,
    subjectId,
    grantId,
    grantLabel,
    onClearGrant
}: {
    subject: core.GrantSubject;
    subjectId: string;
    /** Only this key's uses, when one was picked from the list above. */
    grantId: string | null;
    grantLabel: string;
    onClearGrant: () => void;
}) {
    const t = useTranslations("components");
    const format = useDisplayFormat();
    const [outcome, setOutcome] = useState<Outcome>("all");
    const [uses, setUses] = useState<GrantUseView[] | null>(null);
    const [failed, setFailed] = useState(false);

    const query = new URLSearchParams({ subject, subjectId });
    if (grantId) query.set("grant", grantId);
    if (outcome !== "all") query.set("outcome", outcome);
    const address = `/api/access/uses?${query.toString()}`;

    useEffect(() => {
        const controller = new AbortController();
        setUses(null);
        setFailed(false);
        fetch(address, { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) throw new Error(String(response.status));
                setUses(((await response.json()) as { uses: GrantUseView[] }).uses);
            })
            .catch(() => {
                if (!controller.signal.aborted) setFailed(true);
            });
        return () => controller.abort();
    }, [address]);

    const actionLabel = (action: string) =>
        KNOWN_ACTIONS.has(action)
            ? t(`share.log.actions.${action}` as NamespaceKey<"components">)
            : action;
    const who = (use: GrantUseView) =>
        use.link
            ? use.linkNote
                ? t("share.log.linkFor", { note: use.linkNote })
                : t("share.linkName")
            : use.who || t("share.log.someone");

    return (
        <section
            className="flex min-w-0 flex-col gap-2 border-t border-border pt-4"
            aria-label={t("share.log.title")}
        >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                    <History className="size-4 shrink-0 text-foreground-subtle" aria-hidden />
                    {t("share.log.title")}
                </p>
                <div className="flex items-center gap-2">
                    <SegmentedControl
                        aria-label={t("share.log.filter")}
                        size="sm"
                        value={outcome}
                        onValueChange={setOutcome}
                        options={[
                            { value: "all", label: t("share.log.all") },
                            { value: "done", label: t("share.log.done") },
                            { value: "refused", label: t("share.log.refused") }
                        ]}
                    />
                    <Button asChild size="icon" variant="outline">
                        {/* A plain anchor: a router link would prefetch the download. */}
                        <a
                            href={`${address}&format=csv`}
                            download
                            aria-label={t("share.log.export")}
                            title={t("share.log.export")}
                        >
                            <Download className="size-4 shrink-0" aria-hidden />
                        </a>
                    </Button>
                </div>
            </div>
            {grantId ? (
                <p className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
                    <span className="min-w-0 truncate">
                        {t("share.log.onlyKey", { name: grantLabel })}
                    </span>
                    <button
                        type="button"
                        className="shrink-0 underline"
                        onClick={onClearGrant}
                    >
                        {t("share.log.everyKey")}
                    </button>
                </p>
            ) : null}
            {failed ? (
                <p role="alert" className="text-[12px] text-danger-ink">
                    {t("share.log.unreadable")}
                </p>
            ) : uses === null ? (
                <Skeleton className="h-16 w-full" />
            ) : uses.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">{t("share.log.none")}</p>
            ) : (
                <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                    {uses.map((use) => (
                        <li
                            key={use.id}
                            className="flex min-w-0 items-center gap-2 text-[12px] text-foreground"
                        >
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                                {format.dateTime(use.at)}
                            </span>
                            <span className="min-w-0 flex-1 truncate" title={who(use)}>
                                {who(use)} - {actionLabel(use.action)}
                            </span>
                            <Badge variant={use.outcome === "done" ? "success" : "warning"}>
                                {use.outcome === "done"
                                    ? t("share.log.done")
                                    : use.reason
                                      ? t("share.log.refusedWhy", { why: use.reason })
                                      : t("share.log.refused")}
                            </Badge>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
