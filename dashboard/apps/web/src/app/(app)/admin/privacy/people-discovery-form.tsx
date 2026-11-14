"use client";

/**
 * How people who are not friends or colleagues find each other.
 *
 * Under Privacy, because it is the instance's half of "who can find me": each account still decides that for itself, and this
 * decides which identifiers a stranger may type to get there. The defaults are
 * the closed ones - the whole username and nothing else - because every partial
 * match on strangers is a directory two letters at a time.
 *
 * One Save for the four rows, enabled only while they differ from what is in
 * force. The saved values move on the press and come back if the server
 * refuses, so the button never reads as saved when it is not.
 */

import { useState, useTransition } from "react";
import { setDiscoveryPolicyAction } from "./actions";
import { Button, Card, CardBody, Switch } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DISCOVERY_RULES, type DiscoveryPolicy } from "@/lib/discovery-policy";

export function PeopleDiscoveryForm({ policy }: { policy: DiscoveryPolicy }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [saved, setSaved] = useState<DiscoveryPolicy>(policy);
    const [draft, setDraft] = useState<DiscoveryPolicy>(policy);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [pending, startTransition] = useTransition();

    const dirty = DISCOVERY_RULES.some((rule) => draft[rule] !== saved[rule]);

    function save() {
        const before = saved;
        const next = draft;
        setSaved(next);
        setError(null);
        setDone(false);
        startTransition(async () => {
            const result = await setDiscoveryPolicyAction(next);
            if (result.error) {
                setSaved(before);
                setError(result.error);
                return;
            }
            setDone(true);
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <ul className="flex flex-col divide-y divide-border">
                    {DISCOVERY_RULES.map((rule) => (
                        <li key={rule} className="flex items-start justify-between gap-3 py-2">
                            <div className="flex min-w-0 flex-col gap-0.5">
                                <span className="text-sm">
                                    {t(`privacy.discovery.rules.${rule}.label`)}
                                </span>
                                <span
                                    id={`discovery-${rule}`}
                                    className="text-xs text-muted-foreground"
                                >
                                    {t(`privacy.discovery.rules.${rule}.hint`)}
                                </span>
                            </div>
                            <Switch
                                checked={draft[rule]}
                                disabled={pending}
                                aria-label={t(`privacy.discovery.rules.${rule}.label`)}
                                aria-describedby={`discovery-${rule}`}
                                onChange={(value: boolean) => {
                                    setDraft((current) => ({ ...current, [rule]: value }));
                                    setDone(false);
                                }}
                            />
                        </li>
                    ))}
                </ul>

                {error ? <p className="text-sm text-danger">{error}</p> : null}
                {done && !dirty ? (
                    <p className="text-sm text-muted-foreground">{t("privacy.discovery.saved")}</p>
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
