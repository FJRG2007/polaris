"use client";

/**
 * Whether this server runs the code Polaris built: its files of code against
 * the signed manifest of its build (docs/integrity.md). Loaded on its own after
 * the paint, since the first check of a start hashes every file; "Check again"
 * runs it anew.
 */

import { useState } from "react";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { AfterPaint } from "@/components/after-paint";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Feedback } from "@/app/(app)/account/security/setting-card";
import { CardSkeleton } from "../region-skeletons";
import { ownCodeCheckAction } from "./integrity-actions";
import type { SelfCheck } from "@/lib/integrity/self-check";

const loadCheck = () => ownCodeCheckAction(false);

export function CodeIntegrityCard() {
    return (
        <AfterPaint cacheKey="admin-code-integrity" load={loadCheck} persist={false} skeleton={<CardSkeleton lines={2} />}>
            {(check) => <CodeIntegrityResult initial={check} />}
        </AfterPaint>
    );
}

function CodeIntegrityResult({ initial }: { initial: SelfCheck }) {
    const t = useTranslations("admin");
    const [check, setCheck] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { verdict } = check;

    const again = async () => {
        setBusy(true);
        setError(null);
        try {
            setCheck(await ownCodeCheckAction(true));
        } catch {
            setError(t("security.integrity.failed"));
        } finally {
            setBusy(false);
        }
    };

    const badge =
        verdict.kind === "verified" ? (
            <Badge variant="success">{t("security.integrity.verified")}</Badge>
        ) : verdict.kind === "changed" ? (
            <Badge variant="danger">{t("security.integrity.changed")}</Badge>
        ) : (
            <Badge variant="warning">{t("security.integrity.unverifiable")}</Badge>
        );
    const detail =
        verdict.kind === "verified"
            ? t("security.integrity.verifiedDetail", { count: verdict.checked })
            : verdict.kind === "changed"
              ? t("security.integrity.changedDetail", { count: verdict.paths.length })
              : t(`security.integrity.reason.${verdict.reason}`);

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">{t("security.integrity.title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("security.integrity.hint")}</p>
                    </div>
                    {badge}
                </div>
                <p className="text-sm">{detail}</p>
                {verdict.kind === "changed" ? (
                    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {verdict.paths.slice(0, 10).map((path) => (
                            <li key={path} className="truncate font-mono" title={path}>
                                {path}
                            </li>
                        ))}
                        {verdict.paths.length > 10 ? (
                            <li>{t("security.integrity.more", { count: verdict.paths.length - 10 })}</li>
                        ) : null}
                    </ul>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                        {t("security.integrity.checked")} <RelativeTime iso={check.checkedAt} />
                    </span>
                    <Button size="sm" variant="secondary" onClick={again} disabled={busy} aria-busy={busy}>
                        {t("security.integrity.again")}
                    </Button>
                </div>
                <Feedback error={error ?? undefined} />
            </CardBody>
        </Card>
    );
}
