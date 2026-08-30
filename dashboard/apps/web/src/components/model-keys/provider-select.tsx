"use client";

/**
 * Picking the provider a key belongs to.
 *
 * A plain listbox would do for nine of them, but there are sixty and the list is
 * the place somebody arrives knowing the word ("groq", "kimi", "gemini") rather
 * than where it sits, so it filters. The match runs over the name, the slug and
 * the words people use instead of either, which is how "gemini" finds Google AI
 * and "kimi" finds Moonshot.
 *
 * "free" and "trial" match too, and are the reason the badge is on the row. At
 * sixty providers the question is no longer "which one" but "which of these can
 * I start on today", and the answer was otherwise sixty tabs of pricing pages.
 */

import { Badge, Button, Input } from "@polaris/ui";
import { Check, Search } from "lucide-react";
import { IntegrationLogo } from "@/components/logos";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderRow } from "@/lib/agents/model-key-providers";

/** Only what the list itself needs of a provider. */
type ProviderOption = Pick<ProviderRow, "slug" | "name" | "aliases" | "freeTier">;

/** What the badge says, and what typing it finds. */
const FREE_LABEL = { free: "Free tier", trial: "Free trial" } as const;

export function ProviderSelect({
    options,
    value,
    onChange,
    disabled
}: {
    options: ProviderOption[];
    value: string;
    onChange: (slug: string) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const box = useRef<HTMLDivElement>(null);

    // Closing on an outside press rather than on blur: blur fires as the pointer
    // goes down on a row, which would close the list before the click landed.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!box.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [open]);

    const results = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return options;
        return options.filter((option) =>
            [
                option.name,
                option.slug,
                ...option.aliases,
                ...(option.freeTier ? [FREE_LABEL[option.freeTier.kind], option.freeTier.kind] : [])
            ].some((term) => term.toLowerCase().includes(needle))
        );
    }, [options, query]);

    const chosen = options.find((option) => option.slug === value) ?? null;

    return (
        <div className="relative" ref={box}>
            <button
                type="button"
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen((was) => !was)}
                className="border-border bg-surface flex h-9 w-full items-center gap-2 rounded-md border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
                {chosen ? <IntegrationLogo slug={chosen.slug} className="size-4 shrink-0" /> : null}
                <span
                    className="min-w-0 flex-1 truncate text-left"
                    title={chosen?.name ?? undefined}
                >
                    {chosen?.name ?? "Pick a provider"}
                </span>
            </button>

            {/* bg-card, not bg-popover: there is no popover colour in the preset,
                so that class paints nothing and the menu comes out see-through
                over whatever is under it. */}
            {open ? (
                <div className="bg-elevated absolute z-50 mt-1 w-full rounded-md border border-border-strong shadow-popover">
                    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                        <Search className="text-muted-foreground size-4 shrink-0" />
                        <Input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Search providers"
                            bare
                            className="h-7"
                        />
                    </div>
                    <div className="max-h-64 overflow-y-auto p-1" role="listbox">
                        {results.map((option) => (
                            <Button
                                key={option.slug}
                                type="button"
                                variant="ghost"
                                role="option"
                                aria-selected={option.slug === value}
                                onClick={() => {
                                    onChange(option.slug);
                                    setQuery("");
                                    setOpen(false);
                                }}
                                className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
                            >
                                <Check
                                    className={`size-4 shrink-0 ${option.slug === value ? "opacity-100" : "opacity-0"}`}
                                />
                                <IntegrationLogo slug={option.slug} className="size-4 shrink-0" />
                                <span className="min-w-0 flex-1 truncate" title={option.name}>
                                    {option.name}
                                </span>
                                {option.freeTier ? (
                                    <Badge
                                        variant={option.freeTier.kind === "free" ? "success" : "neutral"}
                                        title={option.freeTier.note}
                                    >
                                        {FREE_LABEL[option.freeTier.kind]}
                                    </Badge>
                                ) : null}
                            </Button>
                        ))}
                        {results.length === 0 ? (
                            <p className="text-muted-foreground px-3 py-6 text-center text-sm">
                                Nothing matches.
                            </p>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
