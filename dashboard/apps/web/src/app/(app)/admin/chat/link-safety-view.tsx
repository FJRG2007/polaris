"use client";

/**
 * Whether links posted in chat are checked against the reputation services set
 * up in Integrations, and which of them are asked.
 *
 * A provider without a key cannot answer, so it is drawn switched off with the
 * place that fixes it rather than offered as a choice that would do nothing.
 */

import Link from "next/link";
import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { Checkbox, Switch } from "@polaris/ui";
import { setLinkSafetyAction } from "./actions";
import { IntegrationLogo } from "@/components/logos";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { LINK_PROVIDER_NAMES } from "@/components/rich-text/link-providers";
import type { LinkSafetyProvider, LinkSafetyProviderState } from "@/lib/chat/link-safety";

interface Overview {
    readonly enabled: boolean;
    readonly providers: readonly LinkSafetyProviderState[];
}

export function LinkSafetyView({ initial }: { initial: Overview }) {
    const t = useTranslations("admin");
    const [enabled, setEnabled] = useState(initial.enabled);
    const [chosen, setChosen] = useState<readonly LinkSafetyProvider[]>(
        initial.providers.filter((entry) => entry.chosen).map((entry) => entry.provider)
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const anyConfigured = initial.providers.some((entry) => entry.configured);

    const save = async (nextEnabled: boolean, nextChosen: readonly LinkSafetyProvider[]) => {
        if (saving) return;
        setSaving(true);
        setError("");
        const was = { enabled, chosen };
        setEnabled(nextEnabled);
        setChosen(nextChosen);
        const result = await runAction(
            () => setLinkSafetyAction({ enabled: nextEnabled, providers: nextChosen }),
            setError
        );
        setSaving(false);
        if (!result || result.error) {
            setEnabled(was.enabled);
            setChosen(was.chosen);
        }
    };

    const toggle = (provider: LinkSafetyProvider, on: boolean) => {
        const next = on ? [...chosen, provider] : chosen.filter((entry) => entry !== provider);
        void save(enabled, next);
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-sm font-medium">{t("chat.linkSafety.label")}</p>
                    <p className="text-xs text-muted-foreground">{t("chat.linkSafety.hint")}</p>
                </div>
                <Switch
                    checked={enabled}
                    onChange={(next) => void save(next, chosen)}
                    disabled={saving}
                    aria-label={t("chat.linkSafety.label")}
                />
            </div>
            {enabled && (
                <ul className="flex flex-col gap-2">
                    {initial.providers.map((entry) => {
                        const name = LINK_PROVIDER_NAMES[entry.provider];
                        const id = `link-safety-${entry.provider}`;
                        return (
                            <li key={entry.provider} className="flex items-start gap-3">
                                <Checkbox
                                    id={id}
                                    className="mt-0.5"
                                    checked={entry.configured && chosen.includes(entry.provider)}
                                    disabled={saving || !entry.configured}
                                    onChange={(event) =>
                                        toggle(entry.provider, event.target.checked)
                                    }
                                />
                                <label htmlFor={id} className="flex min-w-0 flex-col">
                                    <span className="flex items-center gap-2 text-sm">
                                        <IntegrationLogo
                                            slug={entry.provider}
                                            className="size-4 shrink-0"
                                        />
                                        <span className="truncate" title={name}>
                                            {name}
                                        </span>
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {entry.configured
                                            ? t(`chat.linkSafety.${entry.provider}`)
                                            : t("chat.linkSafety.notSetUp")}
                                    </span>
                                </label>
                            </li>
                        );
                    })}
                </ul>
            )}
            {enabled && !anyConfigured && (
                <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-warning-ink">
                    {t("chat.linkSafety.nothingSetUp")}{" "}
                    <Link
                        href="/admin/integrations"
                        className="font-medium underline underline-offset-2"
                    >
                        {t("chat.linkSafety.openIntegrations")}
                    </Link>
                </p>
            )}
            {error && (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}
