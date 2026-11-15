"use client";

/**
 * What the validator found in the draft, listed under the toolbar: errors
 * first (they stop saving and publishing), then warnings. Each row names the
 * step it is about; the same words sit on that step on the canvas.
 */

import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import { issueText, type NodeIssue } from "../shared";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

type T = ReturnType<typeof useTranslations<"automations">>;

/** Each node's most serious finding, worded, for the canvas. Unfinished settings keep their own mark. */
export function nodeIssues(
    t: T,
    issues: readonly core.AutomationIssue[],
    title: (id: string) => string
): Record<string, NodeIssue> {
    const out: Record<string, NodeIssue> = {};
    for (const issue of [...issues].sort(bySeverity)) {
        if (!issue.node || issue.code === "badConfig" || out[issue.node]) continue;
        out[issue.node] = { severity: issue.severity, text: issueText(t, issue, title) };
    }
    return out;
}

function bySeverity(a: core.AutomationIssue, b: core.AutomationIssue): number {
    return (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1);
}

export function IssuesPanel({
    issues,
    title
}: {
    issues: readonly core.AutomationIssue[];
    title: (id: string) => string;
}) {
    const t = useTranslations("automations");
    if (issues.length === 0) return null;
    const errors = issues.filter((issue) => issue.severity === "error").length;
    const sorted = [...issues].sort(bySeverity);
    return (
        <section
            aria-label={t("issues.title")}
            className="rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
            <p className="font-medium">
                {errors > 0
                    ? t("issues.summaryErrors", { errors, warnings: issues.length - errors })
                    : t("issues.summaryWarnings", { warnings: issues.length })}
            </p>
            <ul className="mt-1 max-h-40 space-y-1 overflow-auto overscroll-contain">
                {sorted.map((issue, index) => {
                    const Icon = issue.severity === "error" ? CircleAlert : TriangleAlert;
                    const text = issueText(t, issue, title);
                    return (
                        <li key={index} className="flex min-w-0 items-start gap-2 text-xs">
                            <Icon
                                aria-label={t(`issues.${issue.severity}`)}
                                className={cn(
                                    "mt-0.5 size-3.5 shrink-0",
                                    issue.severity === "error" ? "text-destructive" : "text-warning-ink"
                                )}
                            />
                            <span className="min-w-0 break-words">
                                {issue.node ? (
                                    <span className="font-medium">{`${title(issue.node)}: `}</span>
                                ) : null}
                                {text}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
