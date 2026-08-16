"use client";

/**
 * What this account is willing to show, and to whom.
 *
 * Drawn as a list of rules grouped by area - the same shape the capabilities on
 * an account are drawn in, and for the same reason: seven rows in one
 * undifferentiated column is a wall, and "where is my number" should be answered
 * by a heading rather than by reading every line.
 *
 * Each row is one question and its answer. Three of the six answers name a set
 * of people, and that set is drawn under the row rather than hidden behind the
 * word "except": a setting whose meaning depends on a list you cannot see is a
 * setting nobody trusts.
 *
 * The administrator exception is said in the copy rather than left to be
 * discovered. A privacy screen that quietly does something other than what it
 * says is worse than one that offers less.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { ListsCard } from "./lists-card";
import { runAction } from "@/lib/run-action";
import { Loader2, Users } from "lucide-react";
import { savePrivacyAction } from "./actions";
import { AudienceDialog } from "./audience-dialog";
import type { PrivacyListView } from "@/lib/privacy-service";
import { Button, Card, CardBody, Select } from "@polaris/ui";

export interface NamedPerson {
    readonly id: string;
    readonly name: string;
}

export function PrivacyView({
    settings,
    lists,
    people
}: {
    settings: core.PrivacySettings;
    /** The lists this account saved under a name, which any rule may use. */
    lists: readonly PrivacyListView[];
    /** Names for everybody the rules already name, so the rows can draw them. */
    people: readonly NamedPerson[];
}) {
    const [draft, setDraft] = useState(settings);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [editing, setEditing] = useState<core.PrivacyField | null>(null);
    // Grows as people are picked, so a chip has a name the moment it appears
    // rather than after the page has been through the server again.
    const [named, setNamed] = useState<readonly NamedPerson[]>(people);

    const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

    const save = async () => {
        setSaving(true);
        setError("");
        await runAction(() => savePrivacyAction(draft), setError);
        setSaving(false);
    };

    const nameOf = (id: string) => named.find((person) => person.id === id)?.name ?? "Somebody";

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-4 p-3">
                    {core.PRIVACY_SECTIONS.map((section) => (
                        <section key={section.id} className="flex flex-col gap-1.5">
                            <h3 className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                                {section.label}
                            </h3>
                            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                                {section.fields.map((field) => (
                                    <li
                                        key={field}
                                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
                                    >
                                        <span className="min-w-[12rem] flex-1">
                                            <span className="block text-[13px]">
                                                {core.PRIVACY_FIELD_LABELS[field]}
                                            </span>
                                            <span className="block text-[11px] leading-snug text-foreground-subtle">
                                                {core.PRIVACY_FIELD_NOTES[field]}
                                            </span>
                                        </span>
                                        <Select
                                            className="h-8 w-40 shrink-0 text-xs"
                                            aria-label={core.PRIVACY_FIELD_LABELS[field]}
                                            value={draft[field].audience}
                                            options={core.PRIVACY_AUDIENCES.map((audience) => ({
                                                value: audience,
                                                label: core.PRIVACY_AUDIENCE_LABELS[audience]
                                            }))}
                                            onValueChange={(value) =>
                                                setDraft((current) => ({
                                                    ...current,
                                                    [field]: {
                                                        ...current[field],
                                                        audience: value as core.PrivacyAudience
                                                    }
                                                }))
                                            }
                                        />
                                        {core.audienceNeedsList(draft[field].audience) && (
                                            <Who
                                                rule={draft[field]}
                                                lists={lists}
                                                nameOf={nameOf}
                                                onEdit={() => setEditing(field)}
                                            />
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}

                    <p className="text-[11px] leading-snug text-muted-foreground">
                        Whoever administers this Polaris can see all of it whatever you choose here.
                        They can read the database, so a setting that claimed otherwise would not be
                        true.
                    </p>

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}

                    <div className="flex items-center gap-3">
                        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
                            {saving && <Loader2 className="size-4 shrink-0 animate-spin" />}
                            Save
                        </Button>
                        {!dirty && <span className="text-xs text-muted-foreground">Saved.</span>}
                    </div>
                </CardBody>
            </Card>

            <ListsCard lists={lists} />

            {editing && (
                <AudienceDialog
                    field={editing}
                    rule={draft[editing]}
                    lists={lists}
                    named={named}
                    onNamed={(person) =>
                        setNamed((current) =>
                            current.some((entry) => entry.id === person.id)
                                ? current
                                : [...current, person]
                        )
                    }
                    onChange={(rule) =>
                        setDraft((current) => ({ ...current, [editing]: rule }))
                    }
                    onClose={() => setEditing(null)}
                />
            )}
        </div>
    );
}

/**
 * Who the rule means, under the row that names them.
 *
 * A list that is saved says its name, because that is the thing to go and edit;
 * a set picked here says the people, because there is nothing else it could be
 * called.
 */
function Who({
    rule,
    lists,
    nameOf,
    onEdit
}: {
    rule: core.PrivacyRule;
    lists: readonly PrivacyListView[];
    nameOf: (id: string) => string;
    onEdit: () => void;
}) {
    const list = rule.listId ? lists.find((entry) => entry.id === rule.listId) : null;
    const shown = list ? list.members.map((member) => member.name) : rule.people.map(nameOf);
    const first = shown.slice(0, 3);
    const rest = shown.length - first.length;

    return (
        <div className="flex w-full flex-wrap items-center gap-1.5 pl-0 sm:pl-1">
            <Users className="size-3.5 shrink-0 text-foreground-subtle" />
            {shown.length === 0 ? (
                <span className="text-[11px] text-warning">
                    {list
                        ? "That list is empty, so this names nobody."
                        : "Nobody named yet, so this does nothing."}
                </span>
            ) : (
                <>
                    {list && (
                        <span className="text-[11px] text-muted-foreground">{list.name}:</span>
                    )}
                    {first.map((name) => (
                        <span
                            key={name}
                            className="max-w-[10rem] truncate rounded-full bg-muted px-2 py-0.5 text-[11px]"
                        >
                            {name}
                        </span>
                    ))}
                    {rest > 0 && (
                        <span className="text-[11px] text-muted-foreground">and {rest} more</span>
                    )}
                </>
            )}
            <button
                type="button"
                onClick={onEdit}
                className="rounded text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
            >
                Choose
            </button>
        </div>
    );
}
