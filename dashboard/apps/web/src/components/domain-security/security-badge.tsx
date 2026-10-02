"use client";

/**
 * A domain's security grade as one chip: what a list shows beside a name, and
 * what the card shows beside its heading. The count of problems rides in the
 * tooltip, so a long list stays one line per domain.
 */

import { Badge } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { Grade, Severity } from "@/lib/domain-security/types";
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";

const GRADE_VARIANT: Record<Grade, "success" | "neutral" | "warning" | "danger"> = {
    protected: "success",
    fair: "neutral",
    weak: "warning",
    exposed: "danger",
    unknown: "neutral"
};

export function SecurityBadge({ grade, problems }: { grade: Grade; problems?: number }) {
    const t = useTranslations("domainSecurity");
    const Icon =
        grade === "unknown"
            ? ShieldQuestion
            : grade === "protected" || grade === "fair"
              ? ShieldCheck
              : ShieldAlert;
    return (
        <Badge
            variant={GRADE_VARIANT[grade]}
            title={problems === undefined ? undefined : t("admin.problems", { count: problems })}
        >
            <Icon className="size-3 shrink-0" aria-hidden />
            {t(`grade.${grade}`)}
        </Badge>
    );
}

const SEVERITY_VARIANT: Record<Severity, "success" | "neutral" | "warning" | "danger"> = {
    pass: "success",
    info: "neutral",
    low: "neutral",
    medium: "warning",
    high: "danger",
    critical: "danger"
};

export function SeverityBadge({ severity }: { severity: Severity }) {
    const t = useTranslations("domainSecurity");
    return (
        <Badge variant={SEVERITY_VARIANT[severity]} className="shrink-0">
            {t(`severity.${severity}`)}
        </Badge>
    );
}
