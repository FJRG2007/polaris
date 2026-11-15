"use client";

import { Button, Skeleton } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { useEffect, useState, useTransition } from "react";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { RepoMemorySummary } from "@/lib/agents/repo-memory-store";
import { clearRepoMemoryAction, repoMemoryAction } from "./memory-actions";

/**
 * What the signed-in person's agent remembers about this repository, carried
 * between the machines their sessions run on, with a way to forget it.
 */
export function RepoMemorySection({ repoFullName }: { repoFullName: string }) {
    const t = useTranslations("agents");
    const format = useDisplayFormat();
    const [summary, setSummary] = useState<RepoMemorySummary | null | undefined>(undefined);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState("");
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let live = true;
        void runAction(() => repoMemoryAction(repoFullName), setError).then((result) => {
            if (live) setSummary(result);
        });
        return () => {
            live = false;
        };
    }, [repoFullName]);

    const clear = () => {
        const before = summary;
        setSummary({ files: [], bytes: 0, updatedAt: null });
        setConfirming(false);
        startTransition(async () => {
            const result = await runAction(() => clearRepoMemoryAction(repoFullName), setError);
            if (!result?.ok) {
                setSummary(before);
                setError((current) => current || t("repoMemory.clearFailed"));
            }
        });
    };

    const kilobytes = (bytes: number) => format.number(bytes / 1024, { maximumFractionDigits: 1 });
    const empty = summary !== undefined && (!summary || summary.files.length === 0);

    return (
        <div className="space-y-1">
            <p className="text-sm font-medium">{t("repoMemory.title")}</p>
            <p className="text-xs text-muted-foreground">{t("repoMemory.hint")}</p>
            {summary === undefined ? (
                <Skeleton className="h-8 w-full" />
            ) : empty ? (
                <p className="text-sm text-muted-foreground">{t("repoMemory.empty")}</p>
            ) : (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm" title={summary!.files.map((file) => file.path).join("\n")}>
                        {t("repoMemory.summary", {
                            count: summary!.files.length,
                            size: kilobytes(summary!.bytes),
                            when: format.dateTime(summary!.updatedAt)
                        })}
                    </p>
                    {confirming ? (
                        <>
                            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                                {t("repoMemory.keep")}
                            </Button>
                            <Button size="sm" variant="danger" onClick={clear} disabled={pending}>
                                {t("repoMemory.confirm")}
                            </Button>
                        </>
                    ) : (
                        <Button size="sm" variant="outline" onClick={() => setConfirming(true)} disabled={pending}>
                            {t("repoMemory.clear")}
                        </Button>
                    )}
                </div>
            )}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}
