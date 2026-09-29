"use client";

/**
 * Who one setting means, when its answer names people.
 *
 * Two ways to answer, and the dialog is the one place they are both offered:
 * pick the people here, or use a list already saved under a name. Picking here
 * is first because it is what almost everybody does - a saved list is what the
 * third setting wanting the same four names is for.
 *
 * Nothing is written from here. The choice goes back into the screen's draft and
 * is saved with everything else, so the dropdown above and the people below can
 * never disagree about what is in force.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { searchPeopleAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamedPerson } from "./privacy-view";
import type { PrivacyListView } from "@/lib/privacy-service";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Select
} from "@polaris/ui";

/** The answer to "where do these people come from". */
const PICKED_HERE = "picked";

export function AudienceDialog({
    field,
    rule,
    lists,
    named,
    onNamed,
    onChange,
    onClose
}: {
    field: core.PrivacyField;
    rule: core.PrivacyRule;
    lists: readonly PrivacyListView[];
    /** Names already known for the ids in the rule. */
    named: readonly NamedPerson[];
    /** Somebody picked who was not known before, so the row can draw them. */
    onNamed: (person: NamedPerson) => void;
    onChange: (rule: core.PrivacyRule) => void;
    onClose: () => void;
}) {
    const t = useTranslations("accountPrivacy");
    const [source, setSource] = useState(rule.listId ?? PICKED_HERE);
    const picked: PickedPerson[] = rule.people.map((id) => ({
        id,
        name: named.find((person) => person.id === id)?.name ?? t("somebody")
    }));
    const list = lists.find((entry) => entry.id === source);

    const use = (value: string) => {
        setSource(value);
        // Exactly one of the two ever holds anything, which is what stops a rule
        // meaning one thing on screen and another in the database.
        onChange(
            value === PICKED_HERE
                ? { ...rule, listId: null }
                : { ...rule, listId: value, people: [] }
        );
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    {/* The audience said back in full - "friends except these
                        people" is a different rule from "everybody except these
                        people", and the dialog is where that has to be plain. */}
                    <DialogTitle>{t("dialog.title", { audience: rule.audience })}</DialogTitle>
                    <DialogDescription>
                        {t("dialog.description", { field: t(`fields.${field}.label` as const) })}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    {lists.length > 0 && (
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            {t("dialog.whoToUse")}
                            <Select
                                aria-label={t("dialog.whoToUse")}
                                value={source}
                                onValueChange={use}
                                options={[
                                    { value: PICKED_HERE, label: t("dialog.pickedHere") },
                                    ...lists.map((entry) => ({
                                        value: entry.id,
                                        label: `${entry.name} (${entry.members.length})`
                                    }))
                                ]}
                            />
                        </label>
                    )}

                    {source === PICKED_HERE ? (
                        <PeoplePicker
                            label={t("addSomebody")}
                            picked={picked}
                            search={searchPeopleAction}
                            onChange={(next) => {
                                for (const person of next) onNamed(person);
                                onChange({
                                    ...rule,
                                    listId: null,
                                    people: next.map((person) => person.id)
                                });
                            }}
                        />
                    ) : (
                        <div className="flex flex-col gap-1 rounded-md border border-border p-2">
                            <p className="text-xs text-muted-foreground">
                                {list?.members.length ? t("dialog.everybodyOnList") : t("dialog.emptyList")}
                            </p>
                            <ul className="flex flex-wrap gap-1">
                                {list?.members.map((member) => (
                                    <li
                                        key={member.id}
                                        className="max-w-[10rem] truncate rounded-full bg-muted px-2 py-0.5 text-[0.6875rem]"
                                    >
                                        {member.name}
                                    </li>
                                ))}
                            </ul>
                            <p className="text-[0.6875rem] text-foreground-subtle">
                                {t("dialog.changeUnderLists")}
                            </p>
                        </div>
                    )}
                </div>

                <div className="flex justify-end">
                    <Button size="sm" onClick={onClose}>
                        {t("dialog.done")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
