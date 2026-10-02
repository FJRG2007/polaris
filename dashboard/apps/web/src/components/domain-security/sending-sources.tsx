"use client";

/**
 * Who sends mail as a domain, from its DMARC aggregate reports - or, when
 * Polaris does not read them, where they go instead.
 *
 * The verdict column is the point: it is what tells somebody spoofing the
 * domain from a real sender nobody finished setting up, and from a real sender
 * that should not be sending at all.
 */

import { Badge, CopyButton } from "@polaris/ui";
import { reportHost } from "@/lib/domain-security/records";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DomainSecurityView } from "@/lib/domain-security/service";

const VERDICT_VARIANT = {
    authorized: "success",
    misconfigured: "warning",
    spoofing: "danger"
} as const;

export function SendingSources({
    domain,
    view,
    rua
}: {
    domain: string;
    view: DomainSecurityView;
    rua: readonly string[];
}) {
    const t = useTranslations("domainSecurity");
    const format = new Intl.NumberFormat();

    if (!view.reportAddress) {
        const hosts = [
            ...new Set(rua.map(reportHost).filter((host): host is string => host !== null))
        ];
        return (
            <p className="text-muted-foreground border-t border-border pt-3 text-xs">
                {hosts.length > 0
                    ? t("reports.elsewhere", { domain, hosts: hosts.join(", ") })
                    : t("reports.nowhere", { domain })}
            </p>
        );
    }
    if (!view.sources || view.sources.length === 0) {
        return (
            <p className="text-muted-foreground border-t border-border pt-3 text-xs">
                {t("reports.noneYet", { address: view.reportAddress })}
            </p>
        );
    }
    return (
        <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
            <div>
                <h4 className="text-sm font-medium">{t("reports.title", { domain })}</h4>
                <p className="text-muted-foreground text-xs">{t("reports.intro")}</p>
            </div>
            <div className="min-w-0 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[36rem] text-xs">
                    <thead className="bg-surface/60 text-muted-foreground text-left">
                        <tr>
                            <th scope="col" className="px-3 py-2 font-medium">
                                {t("reports.source")}
                            </th>
                            <th scope="col" className="px-3 py-2 text-right font-medium">
                                {t("reports.messages")}
                            </th>
                            <th scope="col" className="px-3 py-2 text-right font-medium">
                                {t("reports.passed")}
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium">
                                {t("reports.signedBy")}
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium">
                                {t("reports.verdict")}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {view.sources.map((source) => {
                            const signers = [
                                ...new Set([...source.dkimDomains, ...source.spfDomains])
                            ];
                            return (
                                <tr
                                    key={source.sourceIp}
                                    className="border-t border-border align-top"
                                >
                                    <td className="px-3 py-2">
                                        <div className="flex min-w-0 items-center gap-1">
                                            <span className="break-all font-mono">
                                                {source.sourceIp}
                                            </span>
                                            <CopyButton value={source.sourceIp} />
                                        </div>
                                        {source.hostname && (
                                            <span
                                                className="text-muted-foreground block break-all"
                                                title={source.hostname}
                                            >
                                                {source.hostname}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {format.format(source.messages)}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {format.format(source.passed)}
                                    </td>
                                    <td className="break-all px-3 py-2">
                                        {signers.length > 0
                                            ? signers.join(", ")
                                            : t("reports.nobody")}
                                    </td>
                                    <td className="px-3 py-2">
                                        <Badge
                                            variant={VERDICT_VARIANT[source.verdict]}
                                            title={t(`reports.hints.${source.verdict}`)}
                                        >
                                            {t(`reports.verdicts.${source.verdict}`)}
                                        </Badge>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {/* The hover text again, for a reader on a touch screen. */}
            <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
                {[...new Set(view.sources.map((source) => source.verdict))].map((verdict) => (
                    <li key={verdict}>
                        <span className="text-foreground font-medium">
                            {t(`reports.verdicts.${verdict}`)}:
                        </span>{" "}
                        {t(`reports.hints.${verdict}`)}
                    </li>
                ))}
            </ul>
        </div>
    );
}
