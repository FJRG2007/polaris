"use client";

/**
 * A site's public links, for its owner: make one (a name, the window it opens
 * on, an optional password, a lifetime, and whether another site may embed it),
 * copy its address or embed code, and take it down. Shown only to whoever may
 * share the site; the actions check the same.
 */

import { Trash2 } from "lucide-react";
import * as core from "@polaris/core";
import type { AnalyticsScope } from "./site-catalog";
import { CopyButton } from "@/components/copy-button";
import { useConfirm } from "@/components/confirm-dialog";
import { useEffect, useState, useTransition } from "react";
import type { ShareLinkView } from "@/lib/analytics-share";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { createShareLinkAction, deleteShareLinkAction, listShareLinksAction } from "./actions";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Select, Skeleton, Switch } from "@polaris/ui";

type Expiry = "never" | "7" | "30" | "90";

interface Draft {
    label: string;
    password: string;
    expiry: Expiry;
    range: core.VisitRange;
    allowEmbed: boolean;
}

const EMPTY: Draft = { label: "", password: "", expiry: "never", range: "30d", allowEmbed: false };

/** The frame a site pastes to show the report. */
export function embedSnippet(url: string): string {
    return `<iframe src="${url}" style="width:100%;height:1600px;border:0" loading="lazy"></iframe>`;
}

export function ShareLinksCard({ scope, siteId }: { scope: AnalyticsScope; siteId: string }) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    const [links, setLinks] = useState<ShareLinkView[] | null>(null);
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const [failure, setFailure] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmDialog] = useConfirm();

    useEffect(() => {
        let live = true;
        setLinks(null);
        void listShareLinksAction({ scopeType: scope, scopeId: siteId }).then((result) => {
            if (!live) return;
            if (result.error) setFailure(result.error);
            setLinks(result.links ?? []);
        });
        return () => {
            live = false;
        };
    }, [scope, siteId]);

    const password = draft.password.trim();
    const shortPassword = password.length > 0 && password.length < 4;

    const create = () => {
        if (shortPassword || pending) return;
        setFailure(null);
        startTransition(async () => {
            const result = await createShareLinkAction({
                scopeType: scope,
                scopeId: siteId,
                link: {
                    label: draft.label,
                    password: password || null,
                    expiresInDays: draft.expiry === "never" ? null : Number(draft.expiry),
                    range: draft.range,
                    allowEmbed: draft.allowEmbed && !password
                }
            });
            if (result.error || !result.link) return setFailure(result.error ?? null);
            setLinks((current) => [result.link as ShareLinkView, ...(current ?? [])]);
            setDraft(EMPTY);
        });
    };

    const remove = async (link: ShareLinkView) => {
        const ok = await confirm({
            title: t("share.deleteTitle"),
            description: t("share.deleteBody"),
            confirmLabel: t("share.delete"),
            danger: true
        });
        if (!ok) return;
        const before = links;
        // Gone at once, back if the server refuses.
        setLinks((current) => (current ?? []).filter((entry) => entry.id !== link.id));
        const result = await deleteShareLinkAction({ scopeType: scope, scopeId: siteId, id: link.id });
        if (result.error) {
            setLinks(before);
            setFailure(result.error);
        }
    };

    return (
        <Card>
            {confirmDialog}
            <CardHeader>
                <CardTitle className="text-sm">{t("share.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 pt-0">
                <p className="text-sm text-muted-foreground">{t("share.intro")}</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                        <span className="font-medium">{t("share.label")}</span>
                        <Input
                            value={draft.label}
                            maxLength={80}
                            placeholder={t("share.labelPlaceholder")}
                            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                        />
                    </label>
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                        <span className="font-medium">{t("share.password")}</span>
                        {/* enigma:allow-no-breach-check enigma:allow-identity-password -
                            a link's own passphrase, not a credential: it authenticates
                            nobody and guesses at it are limited per link per address. */}
                        <Input
                            type="password"
                            autoComplete="new-password"
                            value={draft.password}
                            maxLength={200}
                            placeholder={t("share.passwordPlaceholder")}
                            aria-invalid={shortPassword}
                            onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                        />
                    </label>
                    <div className="flex min-w-0 flex-col gap-1 text-sm">
                        <span className="font-medium">{t("share.expiry")}</span>
                        <Select
                            value={draft.expiry}
                            aria-label={t("share.expiry")}
                            onValueChange={(value) => setDraft({ ...draft, expiry: value as Expiry })}
                            options={[
                                { value: "never", label: t("share.never") },
                                { value: "7", label: t("share.days", { count: 7 }) },
                                { value: "30", label: t("share.days", { count: 30 }) },
                                { value: "90", label: t("share.days", { count: 90 }) }
                            ]}
                        />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1 text-sm">
                        <span className="font-medium">{t("share.range")}</span>
                        <Select
                            value={draft.range}
                            aria-label={t("share.range")}
                            onValueChange={(value) => setDraft({ ...draft, range: value as core.VisitRange })}
                            options={core.VISIT_RANGES.map((range) => ({
                                value: range,
                                label: t(`ranges.r${range}` as never)
                            }))}
                        />
                    </div>
                </div>
                {shortPassword && <p className="text-sm text-destructive">{t("share.passwordShort")}</p>}
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex min-w-0 items-center gap-2 text-sm">
                        <Switch
                            checked={draft.allowEmbed && !password}
                            disabled={Boolean(password)}
                            aria-label={t("share.embed")}
                            onChange={(checked) => setDraft({ ...draft, allowEmbed: checked })}
                        />
                        <span className="min-w-0">{password ? t("share.embedNoPassword") : t("share.embed")}</span>
                    </label>
                    <Button size="sm" onClick={create} disabled={shortPassword || pending}>
                        {t("share.create")}
                    </Button>
                </div>
                {failure && <p className="text-sm text-destructive">{failure}</p>}

                {links === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : links.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("share.empty")}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                        {links.map((link) => (
                            <li key={link.id} className="flex flex-col gap-2 p-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium" title={link.label || link.url}>
                                            {link.label || t("share.untitled")}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {[
                                                t(`ranges.r${link.range}` as never),
                                                link.hasPassword ? t("share.protected") : t("share.public"),
                                                !link.usable.ok
                                                    ? t("share.expired")
                                                    : link.expiresAt
                                                      ? t("share.until", { date: format.dateTime(link.expiresAt) })
                                                      : null,
                                                t("share.views", { count: link.viewCount })
                                            ]
                                                .filter(Boolean)
                                                .join(" - ")}
                                        </p>
                                    </div>
                                    <a
                                        href={link.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="shrink-0 text-sm text-primary underline-offset-2 hover:underline"
                                    >
                                        {t("share.open")}
                                    </a>
                                    <CopyButton value={link.url} label={t("share.copy")} />
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={t("share.delete")}
                                        onClick={() => void remove(link)}
                                    >
                                        <Trash2 className="size-4 shrink-0" />
                                    </Button>
                                </div>
                                {link.embedUrl && (
                                    <div className="flex min-w-0 items-center gap-2">
                                        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                                            {embedSnippet(link.embedUrl)}
                                        </code>
                                        <CopyButton value={embedSnippet(link.embedUrl)} label={t("share.copyEmbed")} />
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}
