"use client";

/**
 * A page's own hostname: the field to set it, the DNS record it needs, and
 * whether that record already points here - checked by the same DNS check the
 * dashboard's domains use, which also writes the record when a DNS account is
 * connected.
 */

import { unwrap, useStatusT } from "./i18n";
import type { DomainStatus } from "../lib/manage";
import { useEffect, useId, useState } from "react";
import { CheckCircle2, RefreshCw, Trash2 } from "lucide-react";
import { Button, CopyButton, Input, useToast } from "@polaris/ui";
import { isCustomHostname, normalizeHostname } from "../model/schemas";
import { checkCustomDomainAction, setCustomDomainAction } from "../actions/manage";

/** How long to wait between checks while the record is not there yet. */
const RECHECK_MS = 30_000;

export function DomainSection({
    pageId,
    domain,
    published,
    onChanged
}: {
    pageId: string;
    domain: string | null;
    published: boolean;
    onChanged: () => void;
}) {
    const t = useStatusT();
    const toast = useToast();
    const fieldId = useId();
    const [value, setValue] = useState(domain ?? "");
    const [status, setStatus] = useState<DomainStatus | null>(null);
    const [pending, setPending] = useState(false);
    const [checking, setChecking] = useState(false);

    useEffect(() => setValue(domain ?? ""), [domain]);

    const check = () => {
        if (!domain) return;
        setChecking(true);
        unwrap(() => checkCustomDomainAction({ id: pageId }), t("errors.generic"))
            .then((answer) => setStatus(answer.status))
            .catch(() => undefined)
            .finally(() => setChecking(false));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(check, [domain, pageId]);

    // While the record is not there yet, look again on its own, so the screen
    // says when it starts working without being refreshed.
    useEffect(() => {
        if (!domain || !status || status.state === "ready") return;
        const timer = setInterval(check, RECHECK_MS);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [domain, status?.state]);

    const normalized = normalizeHostname(value);
    const valid = normalized === "" || isCustomHostname(normalized);
    const dirty = normalized !== (domain ?? "");
    const ready = valid && dirty && normalized !== "" && !pending;

    const save = (next: string | null) => {
        setPending(true);
        unwrap(() => setCustomDomainAction({ id: pageId, domain: next }), t("errors.generic"))
            .then((answer) => {
                setStatus(answer.status);
                onChanged();
            })
            .catch((caught: Error) =>
                toast.show({ title: t("errors.saveFailed"), body: caught.message })
            )
            .finally(() => setPending(false));
    };

    return (
        <section className="mt-8 space-y-3" aria-labelledby="sp-domain">
            <div>
                <h2 id="sp-domain" className="text-sm font-semibold">
                    {t("domain.heading")}
                </h2>
                <p className="text-xs text-muted-foreground">{t("domain.description")}</p>
            </div>
            <form
                className="flex flex-wrap items-start gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (ready) save(normalized);
                }}
            >
                <div className="min-w-0 flex-1 basis-60 space-y-1">
                    <label htmlFor={fieldId} className="sr-only">
                        {t("domain.heading")}
                    </label>
                    <Input
                        id={fieldId}
                        value={value}
                        maxLength={253}
                        inputMode="url"
                        placeholder="status.example.com"
                        onChange={(event) => setValue(event.target.value)}
                    />
                    {!valid ? (
                        <p className="text-xs text-danger" role="alert">
                            {t("errors.hostname")}
                        </p>
                    ) : null}
                </div>
                <Button
                    type="submit"
                    aria-disabled={!ready}
                    className={ready ? undefined : "opacity-60"}
                >
                    {domain ? t("actions.save") : t("domain.add")}
                </Button>
                {domain ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("domain.remove")}
                        title={t("domain.remove")}
                        disabled={pending}
                        onClick={() => save(null)}
                    >
                        <Trash2 aria-hidden />
                    </Button>
                ) : null}
            </form>

            {domain && !published ? (
                <p className="text-xs text-muted-foreground">{t("domain.unpublished")}</p>
            ) : null}

            {domain && status ? (
                <div className="space-y-2 rounded-lg border border-border bg-card p-4">
                    <div className="flex items-center justify-between gap-2">
                        <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                            {status.state === "ready" ? (
                                <CheckCircle2
                                    className="size-4 shrink-0 text-success"
                                    aria-hidden
                                />
                            ) : null}
                            <span className="min-w-0 break-words">
                                {t(`domain.state.${status.state}`)}
                            </span>
                        </p>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("domain.check")}
                            title={t("domain.check")}
                            disabled={checking}
                            onClick={check}
                        >
                            <RefreshCw
                                className={checking ? "animate-spin" : undefined}
                                aria-hidden
                            />
                        </Button>
                    </div>
                    {status.state !== "ready" && status.ip ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-xs">
                                <thead className="text-muted-foreground">
                                    <tr>
                                        <th className="pr-4 font-normal">{t("domain.type")}</th>
                                        <th className="pr-4 font-normal">{t("domain.name")}</th>
                                        <th className="font-normal">{t("domain.value")}</th>
                                    </tr>
                                </thead>
                                <tbody className="font-mono">
                                    <tr>
                                        <td className="pr-4">A</td>
                                        <td className="break-all pr-4">{status.domain}</td>
                                        <td>
                                            <span className="inline-flex items-center gap-1">
                                                {status.ip}
                                                <CopyButton value={status.ip} />
                                            </span>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    ) : null}
                    {status.state === "conflict" && status.current ? (
                        <p className="break-words text-xs text-muted-foreground">
                            {t("domain.conflict", { current: status.current })}
                        </p>
                    ) : null}
                    {status.state === "manual" && !status.ip ? (
                        <p className="text-xs text-muted-foreground">{t("domain.noIp")}</p>
                    ) : null}
                    {!status.routed ? (
                        <p className="text-xs text-danger">{t("domain.notRouted")}</p>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}
