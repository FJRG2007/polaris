"use client";

/**
 * Who may use Polar, and who may spend this deployment's provider keys in it.
 *
 * Two audiences side by side, each saved the moment it changes and put back if
 * the save is refused. The server reads the same policy on every Polar route,
 * so what this card says is what happens.
 */

import { runAction } from "@/lib/run-action";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { findPolarGroupsAction, findPolarPeopleAction, setPolarAccessAction } from "./actions";
import { Card, CardBody, Input, SegmentedControl, Switch, cn } from "@polaris/ui";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import type { AudienceKind, PolarAudience, PolarPolicy } from "@/lib/polar/access";

type Part = "use" | "spend";
type Group = { id: string; name: string };

/** How long the group search sits still before it asks. */
const SEARCH_AFTER = 220;

export function PolarAccessCard({
    policy,
    groups,
    moreGroups = false,
    chosenGroups = [],
    people
}: {
    policy: PolarPolicy;
    groups: readonly Group[];
    /** Whether the deployment has more groups than `groups` lists, so the rest
     *  are found by searching. */
    moreGroups?: boolean;
    /** Names for the groups the policy already holds. */
    chosenGroups?: readonly Group[];
    /** Names for the people the policy already holds. */
    people: readonly PickedPerson[];
}) {
    const t = useTranslations("admin");
    const [current, setCurrent] = useState(policy);
    const [names, setNames] = useState<readonly PickedPerson[]>(people);
    const [groupNames, setGroupNames] = useState<readonly Group[]>(() => [
        ...chosenGroups,
        ...groups
    ]);
    const [groupQuery, setGroupQuery] = useState("");
    const [foundGroups, setFoundGroups] = useState<readonly Group[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        const term = groupQuery.trim();
        if (!moreGroups || term.length < 2) {
            setFoundGroups(null);
            return;
        }
        let live = true;
        const timer = setTimeout(() => {
            void findPolarGroupsAction(term)
                .then(({ results }) => {
                    if (!live) return;
                    setFoundGroups(results);
                    setGroupNames((known) => [
                        ...known.filter((group) => !results.some((entry) => entry.id === group.id)),
                        ...results
                    ]);
                })
                .catch(() => live && setFoundGroups([]));
        }, SEARCH_AFTER);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [groupQuery, moreGroups]);

    const save = (next: PolarPolicy) => {
        const before = current;
        setError(null);
        // Optimistic, with the policy put back if the write is refused.
        setCurrent(next);
        startTransition(() => {
            void (async () => {
                const result = await runAction(() => setPolarAccessAction(next), setError);
                if (!result || result.error) setCurrent(before);
            })();
        });
    };
    const change = (part: Part, patch: Partial<PolarAudience>) =>
        save({ ...current, [part]: { ...current[part], ...patch } });

    const options = (["admins", "chosen", "everyone"] as const).map((value) => ({
        value,
        label: t(`agents.polarAccess.who.${value}`)
    }));

    const audience = (part: Part) => {
        const value = current[part];
        const picked = value.userIds.map(
            (id) => names.find((person) => person.id === id) ?? { id, name: id }
        );
        const listed = foundGroups ?? groups;
        const shownGroups = [
            ...value.groupIds
                .filter((id) => !listed.some((group) => group.id === id))
                .map((id) => groupNames.find((group) => group.id === id) ?? { id, name: id }),
            ...listed
        ];
        return (
            <div className="space-y-2">
                <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">{t(`agents.polarAccess.${part}.label`)}</p>
                    <p className="text-muted-foreground text-xs">
                        {t(`agents.polarAccess.${part}.hint`)}
                    </p>
                </div>
                <SegmentedControl<AudienceKind>
                    size="sm"
                    value={value.who}
                    options={options}
                    aria-label={t(`agents.polarAccess.${part}.label`)}
                    onValueChange={(who) => change(part, { who })}
                />
                {value.who === "chosen" ? (
                    <div className="space-y-2">
                        <PeoplePicker
                            picked={picked}
                            label={t("agents.polarAccess.people")}
                            search={(query) => findPolarPeopleAction(query)}
                            onChange={(next) => {
                                setNames((known) => [
                                    ...known.filter(
                                        (person) => !next.some((entry) => entry.id === person.id)
                                    ),
                                    ...next
                                ]);
                                change(part, { userIds: next.map((person) => person.id) });
                            }}
                        />
                        {moreGroups ? (
                            <div className="space-y-1">
                                <Input
                                    type="search"
                                    value={groupQuery}
                                    onChange={(event) => setGroupQuery(event.target.value)}
                                    placeholder={t("agents.polarAccess.findGroup")}
                                    aria-label={t("agents.polarAccess.findGroup")}
                                    maxLength={100}
                                />
                                <p className="text-muted-foreground text-xs">
                                    {t("agents.polarAccess.moreGroups")}
                                </p>
                            </div>
                        ) : null}
                        {shownGroups.length > 0 ? (
                            <div
                                className="flex flex-wrap gap-1.5"
                                aria-label={t("agents.polarAccess.groups")}
                            >
                                {shownGroups.map((group) => {
                                    const on = value.groupIds.includes(group.id);
                                    return (
                                        <button
                                            key={group.id}
                                            type="button"
                                            aria-pressed={on}
                                            title={group.name}
                                            onClick={() =>
                                                change(part, {
                                                    groupIds: on
                                                        ? value.groupIds.filter(
                                                              (id) => id !== group.id
                                                          )
                                                        : [...value.groupIds, group.id]
                                                })
                                            }
                                            className={cn(
                                                "max-w-48 truncate rounded-md border border-border px-2 py-0.5 text-xs transition-colors duration-fast",
                                                on
                                                    ? "bg-card-hover text-foreground"
                                                    : "text-muted-foreground hover:bg-card-hover"
                                            )}
                                        >
                                            {group.name}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : foundGroups ? (
                            <p className="text-muted-foreground text-xs">
                                {t("agents.polarAccess.noGroupFound")}
                            </p>
                        ) : (
                            <p className="text-muted-foreground text-xs">
                                {t("agents.polarAccess.noGroups")}
                            </p>
                        )}
                    </div>
                ) : null}
                {value.who !== "admins" ? (
                    <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 text-xs text-muted-foreground">
                            {t("agents.polarAccess.guests")}
                        </p>
                        <Switch
                            checked={value.guests}
                            onChange={(guests) => change(part, { guests })}
                            disabled={pending}
                            aria-label={t("agents.polarAccess.guests")}
                        />
                    </div>
                ) : null}
            </div>
        );
    };

    return (
        <Card>
            <CardBody className="space-y-4">
                {audience("use")}
                {audience("spend")}
                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
