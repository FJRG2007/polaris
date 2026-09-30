"use client";

/**
 * The address Let's Encrypt is given for this server's certificates.
 *
 * It used to be a line in `.env` that the screen told the operator to edit, which
 * nobody running Polaris from its interface can do. Here it is a field, and the
 * card also says whether the edge is running with it: the edge reads it only when
 * it starts, so a saved address is not yet an applied one, and the card offers the
 * restart that applies it rather than leaving the difference invisible.
 */

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Button, Input, Skeleton } from "@polaris/ui";
import { PageSection } from "@/components/page-section";
import type { AcmeContactStatus } from "@/lib/tls/acme-edge";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { restartEdgeAction, saveAcmeEmailAction } from "./actions";
import { acmeEmailProblem, normalizeAcmeEmail } from "@/lib/tls/acme-contact";

const STATUS_URL = "/api/admin/domains/certificate-contact";

/** How long after a restart is asked for the card reads the edge again: the
 *  restart waits for the answer to leave, then takes a few seconds itself. */
const REREAD_AFTER_RESTART_MS = 8_000;

/** The section's anchor, which the certificate warning links to. */
export const CERTIFICATE_CONTACT_ID = "certificate-contact";

export function CertificateContactCard() {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const live = useLiveResource<AcmeContactStatus>({
        url: STATUS_URL,
        cacheKey: "admin.certificateContact",
        intervalMs: 0,
        select: (body) => body as AcmeContactStatus
    });
    const status = live.data;
    const { refresh } = live;
    const [draft, setDraft] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [error, setError] = useState("");

    // Read the edge again once a restart has had time to happen, so the line under
    // the field moves from "not yet" to "in use" without a reload.
    useEffect(() => {
        if (!restarting) return;
        const timer = setTimeout(() => {
            setRestarting(false);
            refresh();
        }, REREAD_AFTER_RESTART_MS);
        return () => clearTimeout(timer);
    }, [restarting, refresh]);

    const value = draft ?? status?.email ?? "";
    const normalized = normalizeAcmeEmail(value);
    const problem = normalized === "" ? null : acmeEmailProblem(normalized);
    const changed = status !== null && normalized !== status.email;

    async function save() {
        if (!status || problem || !changed) return;
        const previous = status;
        setBusy(true);
        setError("");
        // Shown as saved at once; put back if the server refuses it.
        live.replace({ ...previous, email: normalized, source: "setting" });
        const result = await runAction(() => saveAcmeEmailAction(normalized), setError);
        setBusy(false);
        if (!result || "error" in result) {
            live.replace(previous);
            if (result && "error" in result) setError(result.error);
            return;
        }
        live.replace(result.status);
        setDraft(null);
        setRestarting(result.restarting);
    }

    async function restart() {
        setBusy(true);
        setError("");
        const result = await runAction(() => restartEdgeAction(), setError);
        setBusy(false);
        if (result) setRestarting(result.restarting);
    }

    return (
        <PageSection
            id={CERTIFICATE_CONTACT_ID}
            title={t("domains.acme.title")}
            description={t("domains.acme.description")}
        >
            {!status ? (
                <div className="flex flex-col gap-1">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-3 w-4/5" />
                </div>
            ) : (
                <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        {t("domains.acme.label")}
                        <div className="flex gap-2">
                            <Input
                                type="email"
                                value={value}
                                onChange={(event) => setDraft(event.target.value)}
                                placeholder={t("domains.acme.placeholder")}
                                autoComplete="email"
                                aria-invalid={problem !== null}
                                disabled={live.kept}
                            />
                            <Button type="submit" disabled={busy || live.kept || !changed || problem !== null}>
                                {busy ? tc("actions.saving") : tc("actions.save")}
                            </Button>
                        </div>
                    </label>
                    {problem ? (
                        <p className="text-xs text-danger">{t(`domains.acme.errors.${problem}`)}</p>
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            {status.email === ""
                                ? t("domains.acme.none")
                                : status.source === "install"
                                  ? t("domains.acme.fromInstall")
                                  : t("domains.acme.hint")}
                        </p>
                    )}
                    <EdgeLine status={status} restarting={restarting} busy={busy} onRestart={() => void restart()} />
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                </form>
            )}
        </PageSection>
    );
}

/** Whether the edge is running with the address, and what to press when it is not. */
function EdgeLine({
    status,
    restarting,
    busy,
    onRestart
}: {
    status: AcmeContactStatus;
    restarting: boolean;
    busy: boolean;
    onRestart: () => void;
}) {
    const t = useTranslations("admin");
    if (restarting) {
        return (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <RefreshCw className="size-3.5 shrink-0 animate-spin" /> {t("domains.acme.edge.restarting")}
            </p>
        );
    }
    if (status.edge === "current") {
        return <p className="text-xs text-success">{t("domains.acme.edge.current")}</p>;
    }
    if (status.edge === "outdated") {
        return (
            <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                {t.rich("domains.acme.edge.outdated", {
                    link: (chunks) => (
                        <Link key="link" href="/admin/settings" className="text-primary hover:underline">
                            {chunks}
                        </Link>
                    )
                })}
            </p>
        );
    }
    if (status.edge === "pending" && status.canRestart) {
        return (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1">{t("domains.acme.edge.pending")}</span>
                <Button type="button" size="sm" variant="secondary" onClick={onRestart} disabled={busy}>
                    {t("domains.acme.edge.restart")}
                </Button>
            </div>
        );
    }
    // The daemon that could look at the edge, or restart it, is not on this machine.
    return <p className="text-xs text-muted-foreground">{t("domains.acme.edge.unknown")}</p>;
}
