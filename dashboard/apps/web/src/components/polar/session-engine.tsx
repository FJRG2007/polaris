"use client";

/**
 * Which engine runs a Code session: the person's setting on Polar's settings,
 * and the composer's override for one task. Every engine is listed; one that
 * cannot run is disabled with the reason, never offered and then refused. The
 * server resolves the choice again on every start (`engineFor` in
 * `lib/polar/native/engine-choice.ts`).
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Check, Cpu } from "lucide-react";
import {
    cn,
    SearchableSelect,
    useToast,
    type SearchableSelectOption
} from "@polaris/ui";
import {
    SheetMenu,
    SheetMenuContent,
    SheetMenuItem,
    SheetMenuLabel,
    SheetMenuSeparator,
    SheetMenuTrigger
} from "@/components/polar/elements/sheet-menu";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { CodeSource } from "@/lib/polar/agents/code-sources";
import { MODEL_TRIGGER } from "@/components/polar/elements/model-selector";
import {
    AUTO_ENGINE,
    NATIVE_ENGINE,
    NATIVE_RUNTIME_READY,
    engineOptions,
    type EngineDisabledReason,
    type EngineOption
} from "@/lib/polar/native/engine-choice";

type Words = NamespaceTranslator<"polar">;

/** Every CLI id the catalogue knows. */
export const KNOWN_ENGINES: readonly string[] = core.AGENT_CLIS.map((cli) => cli.id);

/** An engine's name: Automatic, Polaris native, or the tool's own. */
export function engineName(id: string, t: Words): string {
    if (id === AUTO_ENGINE) return t("settings.engine.auto");
    if (id === NATIVE_ENGINE) return t("settings.engine.native");
    return core.agentCliById(id)?.label ?? id;
}

/** Why an engine is disabled, in the reader's words. */
export function engineReason(reason: EngineDisabledReason, t: Words): string {
    return t(`settings.engine.${reason}`);
}

/**
 * The settings list: Automatic, Polaris native, then the person's tools (and
 * a stored tool no longer among them, so the pick still reads). Without a
 * model picked, only native's readiness can disable a row.
 */
export function settingOptions(
    tools: readonly string[],
    stored: string | null,
    nativeReady: boolean = NATIVE_RUNTIME_READY
): EngineOption[] {
    const ids = [...new Set([...tools, ...(stored && stored !== NATIVE_ENGINE ? [stored] : [])])];
    return [
        { id: AUTO_ENGINE, disabled: null },
        { id: NATIVE_ENGINE, disabled: nativeReady ? null : "notReady" },
        ...ids.map((id): EngineOption => ({ id, disabled: tools.includes(id) ? null : "notInstalled" }))
    ];
}

async function saveEngine(engine: string | null): Promise<boolean> {
    const response = await fetch("/api/polar/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionEngine: engine })
    }).catch(() => null);
    return !!response?.ok;
}

/** The "Session engine" setting, saved at once and put back if it fails. */
export function SessionEngineSettings({
    tools,
    initial,
    readOnly
}: {
    /** The coding tools this person can run, catalogue ids. */
    tools: readonly string[];
    /** The stored engine; null is Automatic. */
    initial: string | null;
    readOnly: boolean;
}) {
    const t = useTranslations("polar");
    const toast = useToast();
    const [engine, setEngine] = useState<string | null>(initial);
    const options = settingOptions(tools, engine);
    const value = engine ?? AUTO_ENGINE;
    const choose = (next: string) => {
        const stored = next === AUTO_ENGINE ? null : next;
        if (stored === engine) return;
        const before = engine;
        setEngine(stored);
        void saveEngine(stored).then((saved) => {
            if (saved) return;
            setEngine(before);
            toast.show({ title: t("settings.engine.failed") });
        });
    };
    const selectOptions: SearchableSelectOption[] = options.map((option) => ({
        value: option.id,
        label: engineName(option.id, t),
        disabled: option.disabled !== null,
        hint: option.disabled
            ? engineReason(option.disabled, t)
            : option.id === AUTO_ENGINE
              ? t("settings.engine.autoHint")
              : undefined
    }));
    return (
        <section className="flex flex-col gap-2">
            <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">{t("settings.engine.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("settings.engine.intro")}</p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{t("settings.engine.label")}</p>
                    <p className="text-xs text-muted-foreground">{t("settings.engine.hint")}</p>
                </div>
                <div className="w-56 max-w-full min-w-0">
                    <SearchableSelect
                        value={value}
                        onValueChange={choose}
                        options={selectOptions}
                        disabled={readOnly}
                        aria-label={t("settings.engine.label")}
                        searchPlaceholder={t("settings.engine.search")}
                        emptyText={t("settings.engine.noMatch")}
                    />
                </div>
            </div>
        </section>
    );
}

/** Listed in the composer even when they cannot take the picked model. */
const NAMED_ENGINES: ReadonlySet<string> = new Set(["claude", "opencode"]);

function Mark({ on }: { on: boolean }) {
    return <Check className={cn("ms-auto size-3.5 shrink-0 text-primary", !on && "opacity-0")} />;
}

/**
 * The composer's override for one task: "Your setting" (null) or an engine
 * that can run the picked model. Engines that cannot are listed, disabled,
 * with the reason.
 */
export function CodeEnginePill({
    source,
    value,
    onChange,
    disabled
}: {
    source: Pick<CodeSource, "key" | "kind" | "engines">;
    /** Null follows the person's setting. */
    value: string | null;
    onChange: (engine: string | null) => void;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    // Tools that cannot take this model are left out, except the ones people
    // reach for by name, so their reason is still read here.
    const options = engineOptions(source, KNOWN_ENGINES, null).filter(
        (option) => option.disabled !== "cannotServe" || option.id === NATIVE_ENGINE || NAMED_ENGINES.has(option.id)
    );
    const picked = value ? (options.find((option) => option.id === value && option.disabled === null) ?? null) : null;
    const label = picked ? engineName(picked.id, t) : t("settings.engine.yourSetting");
    return (
        <SheetMenu>
            <SheetMenuTrigger disabled={disabled}>
                <button
                    type="button"
                    title={label}
                    aria-label={`${t("settings.engine.label")}: ${label}`}
                    className={cn(MODEL_TRIGGER, "max-w-48 disabled:opacity-60")}
                >
                    <Cpu className="size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate text-foreground">{label}</span>
                </button>
            </SheetMenuTrigger>
            <SheetMenuContent title={t("settings.engine.label")}
                align="start"
                className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain"
            >
                <SheetMenuLabel>{t("settings.engine.label")}</SheetMenuLabel>
                <SheetMenuItem onSelect={() => onChange(null)} className="items-start">
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate">{t("settings.engine.yourSetting")}</span>
                        <span className="text-xs text-muted-foreground">{t("settings.engine.yourSettingHint")}</span>
                    </span>
                    <Mark on={picked === null} />
                </SheetMenuItem>
                <SheetMenuSeparator />
                {options.map((option) => (
                    <SheetMenuItem
                        key={option.id}
                        disabled={option.disabled !== null}
                        onSelect={() => onChange(option.id)}
                        className="items-start"
                    >
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate" title={engineName(option.id, t)}>
                                {engineName(option.id, t)}
                            </span>
                            {option.disabled ? (
                                <span className="text-xs text-muted-foreground">
                                    {engineReason(option.disabled, t)}
                                </span>
                            ) : null}
                        </span>
                        <Mark on={picked?.id === option.id} />
                    </SheetMenuItem>
                ))}
            </SheetMenuContent>
        </SheetMenu>
    );
}
