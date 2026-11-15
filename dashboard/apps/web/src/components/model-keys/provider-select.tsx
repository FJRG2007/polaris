"use client";

/**
 * Picking the provider a key belongs to.
 *
 * The catalogue runs to thousands of providers, so the browser is never handed
 * it: the shared async select reads it a page at a time from the server as the
 * menu opens, narrows it there as somebody types (debounced, an older search
 * aborted), and reads the next page as the list is scrolled towards its end,
 * drawing only the rows on screen. The match runs over the name, the slug and
 * the words people use instead of either, which is how "gemini" finds Google AI
 * and "kimi" finds Moonshot.
 *
 * Two filters sit under it: what kind of provider, and whether a key can be had
 * without paying - at this size the question is often "which of these can I
 * start on today". Each filter is part of the cache key, so flipping back to one
 * already seen draws at once.
 */

import { memo, useCallback, useState } from "react";
import { AsyncSelect, SegmentedControl, type AsyncLoad } from "@polaris/ui";
import { IntegrationLogo } from "@/components/logos";
import type { ProviderRow } from "@/lib/agents/model-key-providers";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** A server action that answers one page of providers. */
export type ProviderReader = (
    input: Record<string, unknown>
) => Promise<{ items: ProviderRow[]; next: string | null } | { error: string }>;

type KindFilter = "all" | "lab" | "host" | "gateway" | "listed" | "custom";
type FreeFilter = "all" | "any";

/** The free-tier badge's words, as `providerSelect.free.<kind>`. */
const FREE_KEYS = { free: "providerSelect.free.free", trial: "providerSelect.free.trial" } as const;

const KINDS: readonly KindFilter[] = ["all", "lab", "host", "gateway", "listed", "custom"];

const slugOf = (row: ProviderRow) => row.slug;
const nameOf = (row: ProviderRow) => row.name;
const logoOf = (row: ProviderRow) => (
    <IntegrationLogo slug={row.slug} name={row.name} className="size-4 shrink-0" />
);

export const ProviderSelect = memo(function ProviderSelect({
    read,
    value,
    selectedLabel,
    onChange,
    disabled
}: {
    read: ProviderReader;
    value: string;
    /** The chosen provider's name, when the dialog already has it. */
    selectedLabel?: string;
    onChange: (slug: string, row: ProviderRow | null) => void;
    disabled?: boolean;
}) {
    const t = useTranslations("components");
    const [kind, setKind] = useState<KindFilter>("all");
    const [free, setFree] = useState<FreeFilter>("all");

    const scope = { kind: kind === "all" ? null : kind, free: free === "all" ? null : free };
    const scopeKey = `${scope.kind ?? ""}:${scope.free ?? ""}`;
    const load = useCallback<AsyncLoad<ProviderRow>>(
        async ({ query, cursor }) => {
            const [k, f] = scopeKey.split(":");
            const result = await read({ query, cursor, kind: k || null, free: f || null });
            if ("error" in result) throw new Error(result.error);
            return result;
        },
        [read, scopeKey]
    );
    const resolve = useCallback(
        async (slug: string) => {
            const result = await read({ ids: [slug] });
            return "error" in result ? null : (result.items[0] ?? null);
        },
        [read]
    );
    const detail = useCallback(
        (row: ProviderRow) => (row.freeTier ? t(FREE_KEYS[row.freeTier.kind]) : null),
        [t]
    );

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <AsyncSelect<ProviderRow>
                value={value || null}
                selectedLabel={selectedLabel}
                onValueChange={(slug, row) => onChange(slug, row)}
                load={load}
                resolve={resolve}
                cacheKey={`model-key-providers:${scopeKey}`}
                itemValue={slugOf}
                itemLabel={nameOf}
                itemDetail={detail}
                itemIcon={logoOf}
                disabled={disabled}
                placeholder={t("providerSelect.pick")}
                searchPlaceholder={t("providerSelect.search")}
                emptyText={t("providerSelect.none")}
                aria-label={t("providerSelect.pick")}
                className="h-9"
            />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="min-w-0 max-w-full overflow-x-auto">
                    <SegmentedControl<KindFilter>
                        size="sm"
                        value={kind}
                        onValueChange={setKind}
                        aria-label={t("providerSelect.kindLabel")}
                        options={KINDS.map((option) => ({
                            value: option,
                            label: t(`providerSelect.kind.${option}`)
                        }))}
                    />
                </div>
                <SegmentedControl<FreeFilter>
                    size="sm"
                    value={free}
                    onValueChange={setFree}
                    aria-label={t("providerSelect.freeLabel")}
                    options={[
                        { value: "all", label: t("providerSelect.kind.all") },
                        { value: "any", label: t("providerSelect.freeOnly") }
                    ]}
                />
            </div>
        </div>
    );
});
