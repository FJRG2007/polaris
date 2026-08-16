"use client";

/**
 * What this account is willing to show, and who counts as a friend.
 *
 * The two are on one screen because one is the answer to the other: "friends
 * only" is meaningless until there is a list, and a list of friends that decided
 * nothing would be an address book nobody would keep.
 *
 * Drawn as a list of rules rather than as a stack of blocks, which is the same
 * shape the permissions on an account are drawn in - each row is one question,
 * its answer on the right, and the whole set is read down the page in one go.
 * The earlier layout gave each setting a heading, a full-width control and a
 * paragraph, so four questions filled a screen and the fifth would have needed
 * scrolling to find out about.
 *
 * The reciprocity of read receipts is said in the copy rather than left to be
 * discovered, and so is the administrator exception. A privacy screen that
 * quietly does something other than what it says is worse than one that offers
 * less.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { savePrivacyAction } from "./actions";
import { Button, Card, CardBody, SegmentedControl } from "@polaris/ui";

export function PrivacyView({ settings }: { settings: core.PrivacySettings }) {
    const [draft, setDraft] = useState(settings);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

    const save = async () => {
        setSaving(true);
        setError("");
        await runAction(() => savePrivacyAction(draft), setError);
        setSaving(false);
    };

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-3 p-3">
                    <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                        {core.PRIVACY_FIELDS.map((field) => (
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
                                <SegmentedControl
                                    size="sm"
                                    className="shrink-0"
                                    aria-label={core.PRIVACY_FIELD_LABELS[field]}
                                    value={draft[field]}
                                    onValueChange={(value) =>
                                        setDraft((current) => ({ ...current, [field]: value }))
                                    }
                                    options={core.PRIVACY_AUDIENCES.map((audience) => ({
                                        value: audience,
                                        label: core.PRIVACY_AUDIENCE_LABELS[audience]
                                    }))}
                                />
                            </li>
                        ))}
                    </ul>

                    <p className="text-[11px] leading-snug text-muted-foreground">
                        Whoever administers this Polaris can see all of it whatever you choose
                        here. They can read the database, so a setting that claimed otherwise
                        would not be true.
                    </p>

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}

                    <div className="flex items-center gap-3">
                        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
                            {saving && <Loader2 className="size-4 animate-spin" />}
                            Save
                        </Button>
                        {!dirty && <span className="text-xs text-muted-foreground">Saved.</span>}
                    </div>
                </CardBody>
            </Card>
        </div>
    );
}
