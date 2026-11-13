"use client";

/**
 * Enigma on Polar's settings: the master switch, the settings a person changes
 * most, and each skill the pinned version ships with its own switch. They apply
 * to every coding session the person starts, and the skills and rules to Chat.
 *
 * Every change is saved at once and put back when the server refuses it.
 */

import { useState } from "react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { Card, CardBody, Select, Switch } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    ENIGMA_CHOICES,
    ENIGMA_CHOICE_KEYS,
    ENIGMA_TOGGLE_KEYS,
    type EnigmaPrefs
} from "@/lib/polar/enigma-prefs";
import { saveEnigmaAction } from "./skills-actions";

type Key = NamespaceKey<"polar">;

export interface EnigmaSkillRow {
    readonly name: string;
    readonly description: string;
}

function Row({
    label,
    hint,
    children
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={label}>
                    {label}
                </p>
                {hint ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground" title={hint}>
                        {hint}
                    </p>
                ) : null}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}

export function EnigmaSettings({
    initial,
    available,
    skills,
    readOnly
}: {
    initial: EnigmaPrefs;
    available: boolean;
    skills: readonly EnigmaSkillRow[];
    readOnly: boolean;
}) {
    const t = useTranslations("polar");
    const [prefs, setPrefs] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const off = new Set(prefs.skillsOff);

    async function save(next: EnigmaPrefs) {
        const before = prefs;
        setError(null);
        setPrefs(next);
        const answer = await saveEnigmaAction(next);
        if (!answer.ok) {
            setPrefs(before);
            setError(answer.error);
        }
    }

    function setSkill(name: string, on: boolean) {
        const rest = prefs.skillsOff.filter((entry) => entry !== name);
        void save({ ...prefs, skillsOff: on ? rest : [...rest, name] });
    }

    return (
        <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
                <h2 className="text-sm font-semibold">Enigma {/* i18n-ignore a product's name */}</h2>
                <p className="text-sm text-muted-foreground">{t("settings.enigma.intro")}</p>
            </div>
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            <Card>
                <CardBody className="flex flex-col divide-y divide-border p-0">
                    <Row label={t("settings.enigma.use")} hint={t("settings.enigma.chatNote")}>
                        <Switch
                            checked={prefs.enabled}
                            disabled={readOnly}
                            aria-label={t("settings.enigma.use")}
                            onChange={(enabled) => void save({ ...prefs, enabled })}
                        />
                    </Row>
                    {prefs.enabled ? (
                        <>
                            {ENIGMA_CHOICE_KEYS.map((key) => (
                                <Row
                                    key={key}
                                    label={t(`settings.enigma.fields.${key}.label` as Key)}
                                    hint={t(`settings.enigma.fields.${key}.hint` as Key)}
                                >
                                    <Select
                                        value={prefs.choices[key]}
                                        disabled={readOnly}
                                        className="w-36"
                                        onValueChange={(value) =>
                                            void save({
                                                ...prefs,
                                                choices: { ...prefs.choices, [key]: value }
                                            })
                                        }
                                        options={ENIGMA_CHOICES[key].values.map((value) => ({
                                            value,
                                            label: t(`settings.enigma.fields.${key}.values.${value}` as Key)
                                        }))}
                                    />
                                </Row>
                            ))}
                            <Row
                                label={t("settings.enigma.fields.gate.label")}
                                hint={t("settings.enigma.fields.gate.hint")}
                            >
                                <Switch
                                    checked={prefs.gate}
                                    disabled={readOnly}
                                    aria-label={t("settings.enigma.fields.gate.label")}
                                    onChange={(gate) => void save({ ...prefs, gate })}
                                />
                            </Row>
                            {ENIGMA_TOGGLE_KEYS.map((key) => (
                                <Row
                                    key={key}
                                    label={t(`settings.enigma.fields.${key}.label` as Key)}
                                    hint={t(`settings.enigma.fields.${key}.hint` as Key)}
                                >
                                    <Switch
                                        checked={prefs.toggles[key]}
                                        disabled={readOnly}
                                        aria-label={t(`settings.enigma.fields.${key}.label` as Key)}
                                        onChange={(on) =>
                                            void save({
                                                ...prefs,
                                                toggles: { ...prefs.toggles, [key]: on }
                                            })
                                        }
                                    />
                                </Row>
                            ))}
                        </>
                    ) : null}
                </CardBody>
            </Card>
            {prefs.enabled ? (
                <div className="flex flex-col gap-3">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t("settings.enigma.skillsTitle")}
                    </h3>
                    {!available ? (
                        <p className="text-sm text-muted-foreground">{t("settings.enigma.unavailable")}</p>
                    ) : (
                        <Card>
                            <CardBody className="flex flex-col divide-y divide-border p-0">
                                {skills.map((skill) => (
                                    <Row key={skill.name} label={skill.name} hint={skill.description}>
                                        <Switch
                                            checked={!off.has(skill.name)}
                                            disabled={readOnly}
                                            aria-label={t("settings.enigma.useSkill", { name: skill.name })}
                                            onChange={(on) => setSkill(skill.name, on)}
                                        />
                                    </Row>
                                ))}
                            </CardBody>
                        </Card>
                    )}
                </div>
            ) : null}
        </section>
    );
}
