"use client";

/**
 * Translate's settings for this whole Polaris: which engines may answer, the
 * order they are tried in, and the language a new translation goes into. The
 * order is the list itself, set by dragging a row (or its arrows, from the
 * keyboard), as the AI keys are. An administrator's page, reached
 * from the app's menu under Polaris apps like every other app's settings.
 * An optional limit on one translation is off unless the administrator
 * turns it on. Save waits for a change; the keys themselves are on the Integrations screen,
 * which the page links to.
 */

import Link from "next/link";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useLanguageOptions } from "./language-options";
import { unwrap, useTranslateLocale, useTranslateT } from "./i18n";
import { saveSettingsAction, settingsAction } from "../actions/translate";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import {
    CHAR_LIMIT_MAX,
    CHAR_LIMIT_MIN,
    type EngineId,
    type TranslateSettings
} from "../model/schemas";
import {
    Button,
    Card,
    Input,
    SearchableSelect,
    Skeleton,
    Switch,
    isDirty,
    useToast
} from "@polaris/ui";

/** The limit a newly switched-on field starts at. */
const LIMIT_START = 5000;

/** What the limit field says, as a limit: null when off, NaN when it is not one. */
export function limitOf(text: string | null): number | null {
    if (text === null) return null;
    const value = Number(text.trim());
    return text.trim() && Number.isInteger(value) && value >= CHAR_LIMIT_MIN && value <= CHAR_LIMIT_MAX
        ? value
        : Number.NaN;
}

const NAME = {
    browser: "engine.browser",
    polar: "engine.polar",
    deepl: "engine.deepl",
    google: "engine.google"
} as const;

const HINT = {
    browser: "settings.browserHint",
    polar: "settings.polarHint",
    deepl: "settings.deeplHint",
    google: "settings.googleHint"
} as const;

export function SettingsPanel() {
    const t = useTranslateT();
    const toast = useToast();
    const ids = useId();
    const languages = useLanguageOptions(useTranslateLocale());
    const [loaded, setLoaded] = useState<TranslateSettings | null>(null);
    const [draft, setDraft] = useState<TranslateSettings | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [limitText, setLimitText] = useState<string | null>(null);

    const load = () => {
        setFailed(null);
        void unwrap(() => settingsAction(), t("errors.generic"))
            .then((answer) => {
                setLoaded(answer.settings);
                setDraft(answer.settings);
                setLimitText(answer.settings.charLimit === null ? null : String(answer.settings.charLimit));
            })
            .catch((caught: Error) => setFailed(caught.message));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once, on arrival
    useEffect(load, []);

    const limit = limitOf(limitText);
    const limitValid = limit === null || !Number.isNaN(limit);
    const edited = draft && limitValid ? { ...draft, charLimit: limit } : draft;
    const changed =
        loaded !== null &&
        draft !== null &&
        (!limitValid || (edited !== null && isDirty(loaded, edited)));

    const save = async () => {
        if (!edited || !changed || !limitValid) return;
        setSaving(true);
        try {
            const answer = await unwrap(() => saveSettingsAction(edited), t("errors.saveFailed"));
            setLoaded(answer.settings);
            setDraft(answer.settings);
            setLimitText(answer.settings.charLimit === null ? null : String(answer.settings.charLimit));
            toast.show({ title: t("settings.saved") });
        } catch (caught) {
            toast.show({ title: t("errors.saveFailed"), body: (caught as Error).message });
        } finally {
            setSaving(false);
        }
    };

    const toggle = (id: EngineId, on: boolean) =>
        setDraft((current) =>
            current ? { ...current, engines: { ...current.engines, [id]: on } } : current
        );

    const move = (from: number, to: number) =>
        setDraft((current) => {
            if (!current || from === to || to < 0 || to >= current.order.length) return current;
            const order = [...current.order];
            const [id] = order.splice(from, 1);
            if (!id) return current;
            order.splice(to, 0, id);
            return { ...current, order };
        });

    if (failed !== null)
        return (
            <Card className="flex min-w-0 flex-col items-start gap-3 p-4">
                <p className="text-sm">{failed}</p>
                <Button variant="outline" size="sm" onClick={load}>
                    {t("settings.retry")}
                </Button>
            </Card>
        );

    return (
        <Card className="flex min-w-0 flex-col gap-5 p-4">
            {draft === null ? (
                <div className="space-y-3">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
            ) : (
                <>
                    <fieldset className="space-y-3">
                        <legend className="text-sm font-medium">{t("settings.engines")}</legend>
                        <p className="text-xs text-muted-foreground">{t("settings.orderHint")}</p>
                        {draft.order.map((id, index) => (
                            <EngineRow
                                key={id}
                                index={index}
                                total={draft.order.length}
                                onMove={move}
                                upLabel={t("settings.moveUp", { engine: t(NAME[id]) })}
                                downLabel={t("settings.moveDown", { engine: t(NAME[id]) })}
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm">{t(NAME[id])}</p>
                                    <p
                                        id={`${ids}-${id}`}
                                        className="text-xs text-muted-foreground"
                                    >
                                        {t(HINT[id])}
                                    </p>
                                </div>
                                <Switch
                                    checked={draft.engines[id]}
                                    onChange={(on) => toggle(id, on)}
                                    aria-label={t(NAME[id])}
                                    aria-describedby={`${ids}-${id}`}
                                />
                            </EngineRow>
                        ))}
                        <Link
                            href="/admin/integrations"
                            className="inline-block text-xs text-primary underline-offset-2 hover:underline"
                        >
                            {t("settings.keys")}
                        </Link>
                    </fieldset>
                    <div className="max-w-sm space-y-1.5">
                        <p className="text-sm font-medium">{t("settings.target")}</p>
                        <SearchableSelect
                            className="w-full"
                            aria-label={t("settings.target")}
                            value={draft.defaultTarget}
                            onValueChange={(value) =>
                                setDraft((current) =>
                                    current
                                        ? {
                                              ...current,
                                              defaultTarget:
                                                  value as TranslateSettings["defaultTarget"]
                                          }
                                        : current
                                )
                            }
                            options={languages}
                            searchPlaceholder={t("lang.search")}
                            emptyText={t("lang.none")}
                        />
                    </div>
                    <div className="max-w-sm space-y-1.5">
                        <div className="flex min-w-0 items-start gap-2">
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">{t("settings.limit")}</p>
                                <p id={`${ids}-limit`} className="text-xs text-muted-foreground">
                                    {t("settings.limitHint")}
                                </p>
                            </div>
                            <Switch
                                checked={limitText !== null}
                                onChange={(on) => setLimitText(on ? String(LIMIT_START) : null)}
                                aria-label={t("settings.limitOn")}
                                aria-describedby={`${ids}-limit`}
                            />
                        </div>
                        {limitText !== null ? (
                            <>
                                <Input
                                    type="number"
                                    inputMode="numeric"
                                    min={CHAR_LIMIT_MIN}
                                    max={CHAR_LIMIT_MAX}
                                    step={1}
                                    value={limitText}
                                    onChange={(event) => setLimitText(event.target.value)}
                                    aria-label={t("settings.limitChars")}
                                    aria-invalid={!limitValid}
                                />
                                {!limitValid ? (
                                    <p className="text-xs text-destructive">
                                        {t("settings.limitInvalid", {
                                            min: CHAR_LIMIT_MIN,
                                            max: CHAR_LIMIT_MAX
                                        })}
                                    </p>
                                ) : null}
                            </>
                        ) : null}
                    </div>
                </>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                <Button
                    variant="outline"
                    onClick={() => {
                        setDraft(loaded);
                        setLimitText(loaded?.charLimit == null ? null : String(loaded.charLimit));
                    }}
                    disabled={!changed || saving}
                >
                    {t("settings.cancel")}
                </Button>
                <Button onClick={() => void save()} disabled={!changed || !limitValid || saving}>
                    {t("settings.save")}
                </Button>
            </div>
        </Card>
    );
}

/** One engine in the order: dragged by its row, or moved with its arrows. */
function EngineRow({
    index,
    total,
    upLabel,
    downLabel,
    onMove,
    children
}: {
    index: number;
    total: number;
    upLabel: string;
    downLabel: string;
    onMove: (from: number, to: number) => void;
    children: ReactNode;
}) {
    const [over, setOver] = useState(false);
    return (
        <div
            draggable
            onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))}
            onDragOver={(event) => {
                // Without this the drop never fires: a dragover refuses it by default.
                event.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                event.preventDefault();
                setOver(false);
                const from = Number(event.dataTransfer.getData("text/plain"));
                if (Number.isInteger(from)) onMove(from, index);
            }}
            className={`flex min-w-0 items-start gap-2 rounded-md px-1 py-1.5 ${over ? "bg-muted/40" : ""}`}
        >
            <span className="flex shrink-0 items-center gap-1 pt-0.5">
                <GripVertical
                    className="size-4 shrink-0 cursor-grab text-muted-foreground"
                    aria-hidden
                />
                <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">
                    {index + 1}
                </span>
            </span>
            {children}
            <span className="flex shrink-0 items-center">
                <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === 0}
                    onClick={() => onMove(index, index - 1)}
                    aria-label={upLabel}
                    title={upLabel}
                >
                    <ChevronUp className="size-4 shrink-0" aria-hidden />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === total - 1}
                    onClick={() => onMove(index, index + 1)}
                    aria-label={downLabel}
                    title={downLabel}
                >
                    <ChevronDown className="size-4 shrink-0" aria-hidden />
                </Button>
            </span>
        </div>
    );
}
