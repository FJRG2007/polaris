"use client";

/**
 * How many server terminals each account may keep open at once. A terminal
 * keeps running after its tab is closed, so this is what stops one person
 * leaving dozens of shells open on the machines Polaris reaches.
 */

import { useState, useTransition } from "react";
import { Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { saveTerminalSessionCapAction } from "./terminal-actions";

export function TerminalSessionsCard({ cap, max }: { cap: number; max: number }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [stored, setStored] = useState(cap);
    const [value, setValue] = useState(String(cap));
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [pending, startTransition] = useTransition();

    const parsed = Number(value.trim());
    const valid = value.trim() !== "" && Number.isInteger(parsed) && parsed >= 1 && parsed <= max;
    // Dirty means it differs from what is stored, not that somebody typed in it.
    const dirty = valid && parsed !== stored;

    function save() {
        setError(null);
        setSaved(false);
        startTransition(async () => {
            const result = await saveTerminalSessionCapAction(parsed);
            if (result.error) {
                setError(result.error);
                return;
            }
            setStored(parsed);
            setSaved(true);
        });
    }

    return (
        <Card className="mt-4">
            <CardHeader>
                <CardTitle>{t("settings.terminal.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t("settings.terminal.body")}</p>
                <label className="flex max-w-[12rem] flex-col gap-1 text-sm">
                    <span className="font-medium">
                        {t("settings.terminal.label")} <span aria-hidden="true">*</span>
                    </span>
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={max}
                        value={value}
                        aria-invalid={value.trim() !== "" && !valid}
                        onChange={(event) => {
                            setValue(event.target.value);
                            setSaved(false);
                        }}
                    />
                    <span className="text-xs text-muted-foreground">
                        {value.trim() !== "" && !valid
                            ? t("settings.terminal.invalid", { max })
                            : t("settings.terminal.hint", { max })}
                    </span>
                </label>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                {saved && !dirty ? (
                    <p className="text-sm text-muted-foreground">{t("settings.terminal.saved")}</p>
                ) : null}
                <Button
                    className="self-start"
                    size="sm"
                    disabled={!dirty || pending}
                    onClick={save}
                >
                    {tc("actions.save")}
                </Button>
            </CardBody>
        </Card>
    );
}
