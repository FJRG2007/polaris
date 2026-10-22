"use client";

/**
 * The security scans' findings table: the shared vulnerability table with the
 * scans' own words. Kept under its old name so the screens and their tests
 * read it where they always did.
 */

import type { ComponentProps } from "react";
import type { SecurityTranslator } from "../lib/i18n";
import { VulnerabilityTable, type VulnerabilityTableLabels } from "@polaris/ui";

export {
    arrangeFindings,
    SEVERITY_ORDER,
    splitPackage,
    type ImageFinding,
    type SortKey
} from "@polaris/ui";

/** The table's words from the scans' catalog. */
export function findingsLabels(t: SecurityTranslator): VulnerabilityTableLabels {
    return {
        failed: t("findings.failed"),
        tryAgain: t("tryAgain"),
        none: t("findings.none"),
        filters: t("findings.filters"),
        fixedOnly: t("findings.fixedOnly"),
        vulnerability: t("findings.vulnerability"),
        severity: t("findings.severity"),
        package: t("findings.package"),
        fix: t("findings.fix"),
        layer: t("findings.layer"),
        noMatch: t("findings.noMatch"),
        noFix: t("images.noFix"),
        severityName: (severity) => t(`images.severity.${severity}` as never),
        openAdvisory: (id) => t("findings.openAdvisory", { id })
    };
}

export function FindingsTable({
    t,
    ...rest
}: { t: SecurityTranslator } & Omit<ComponentProps<typeof VulnerabilityTable>, "labels">) {
    return <VulnerabilityTable labels={findingsLabels(t)} {...rest} />;
}
