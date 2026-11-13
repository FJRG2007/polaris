"use client";

/**
 * Whether the deploy addresses (`*.plr.example.com`) are covered by one trusted
 * certificate.
 *
 * Without it, an address nothing is deployed on - and a new one in the seconds before
 * its own certificate arrives - is served with the edge's self-signed certificate, and
 * the browser says it is not secure. The catch-all that answers those addresses never
 * orders a certificate per name, because anyone walking the zone would spend the
 * certificate authority's limits that way. The wildcard is the only fix, and it needs
 * DNS access, so the card says which of the two is missing and offers what fixes it.
 */

import Link from "next/link";
import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { Button, Skeleton } from "@polaris/ui";
import { PageSection } from "@/components/page-section";
import { issueWildcardCertificateAction } from "./actions";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { WildcardCertView, WildcardProblem } from "@/lib/wildcard-cert-service";

const STATUS_URL = "/api/admin/domains/wildcard-certificate";

/** Where a Cloudflare token is connected. */
const CONNECT_URL = "/admin/integrations?configure=cloudflare";

/** The catalog key each problem is worded under. */
const PROBLEM_KEY: Record<NonNullable<WildcardProblem>, "noDnsAccess" | "orderFailed" | "pending"> = {
    "no-dns-access": "noDnsAccess",
    "order-failed": "orderFailed",
    pending: "pending"
};

export function WildcardCertificateCard() {
    const t = useTranslations("admin");
    const format = useDisplayFormat();
    const live = useLiveResource<WildcardCertView>({
        url: STATUS_URL,
        cacheKey: "admin.wildcardCertificate",
        intervalMs: 0,
        select: (body) => body as WildcardCertView
    });
    const view = live.data;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    if (view && !view.needed) return null;

    async function issue() {
        setBusy(true);
        setError("");
        const result = await runAction(() => issueWildcardCertificateAction(), setError);
        setBusy(false);
        if (result) live.replace(result);
    }

    return (
        <PageSection title={t("domains.wildcard.title")} description={t("domains.wildcard.description")}>
            {!view ? (
                <div className="flex flex-col gap-1">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-3 w-4/5" />
                </div>
            ) : view.problem === null ? (
                <p className="min-w-0 break-words text-sm text-success">
                    {t("domains.wildcard.covered", {
                        base: view.base ?? "",
                        when: view.expiresAt ? format.date(view.expiresAt) : ""
                    })}
                </p>
            ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                    <span className="min-w-0 flex-1 break-words">
                        {t(`domains.wildcard.problem.${PROBLEM_KEY[view.problem]}`, { base: view.base ?? "" })}
                    </span>
                    {view.problem === "no-dns-access" ? (
                        <Button asChild size="sm" variant="secondary">
                            <Link href={CONNECT_URL}>{t("domains.wildcard.connect")}</Link>
                        </Button>
                    ) : (
                        <Button type="button" size="sm" variant="secondary" onClick={() => void issue()} disabled={busy || live.kept}>
                            {busy ? t("domains.wildcard.issuing") : t("domains.wildcard.issue")}
                        </Button>
                    )}
                </div>
            )}
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : null}
        </PageSection>
    );
}
