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
import { Eye, Pencil } from "lucide-react";
import { Button, Card, CardBody, Select, Switch } from "@polaris/ui";
import { skillKey } from "@/lib/polar/skills/overrides";
import type { OverrideSummary } from "@/lib/polar/skills/override-store";
import { EditedBadges, SkillDetailDialog, type SkillTarget } from "./skill-detail-dialog";
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
    badges,
    children
}: {
    label: string;
    hint?: string;
    /** Under the hint, so on a phone they never squeeze the label. */
    badges?: React.ReactNode;
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
                {badges ? <div className="mt-1 flex flex-wrap gap-1">{badges}</div> : null}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}

export function EnigmaSettings({
    initial,
    available,
    skills,
    summaries: initialSummaries,
    readOnly
}: {
    initial: EnigmaPrefs;
    available: boolean;
    skills: readonly EnigmaSkillRow[];
    /** Enigma's skills by key: edited, outdated. */
    summaries: Record<string, OverrideSummary>;
    readOnly: boolean;
}) {
    const t = useTranslations("polar");
    const [prefs, setPrefs] = useState(initial);
    const [summaries, setSummaries] = useState(initialSummaries);
    const [detail, setDetail] = useState<SkillTarget>(null);
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
                                    <Row
                                        key={skill.name}
                                        label={skill.name}
                                        hint={skill.description}
                                        badges={
                                            summaries[skillKey("enigma", skill.name)]?.edited ? (
                                                <EditedBadges summary={summaries[skillKey("enigma", skill.name)]} />
                                            ) : null
                                        }
                                    >
                                        <div className="flex items-center gap-2">
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            aria-label={readOnly ? t("settings.skills.upstream.open") : t("settings.skills.upstream.openEdit")}
                                            title={readOnly ? t("settings.skills.upstream.open") : t("settings.skills.upstream.openEdit")}
                                            onClick={() => setDetail({ kind: "upstream", key: skillKey("enigma", skill.name) })}
                                        >
                                            {readOnly ? <Eye className="size-4 shrink-0" /> : <Pencil className="size-4 shrink-0" />}
                                        </Button>
                                        <Switch
                                            checked={!off.has(skill.name)}
                                            disabled={readOnly}
                                            aria-label={t("settings.enigma.useSkill", { name: skill.name })}
                                            onChange={(on) => setSkill(skill.name, on)}
                                        />
                                        </div>
                                    </Row>
                                ))}
                            </CardBody>
                        </Card>
                    )}
                </div>
            ) : null}
            <SkillDetailDialog
                target={detail}
                readOnly={readOnly}
                onClose={() => setDetail(null)}
                onChanged={(key, next) => setSummaries((current) => ({ ...current, [key]: next }))}
            />
        </section>
    );
}
