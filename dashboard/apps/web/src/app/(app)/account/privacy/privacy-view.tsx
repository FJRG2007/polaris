"use client";

/**
 * What this account is willing to show, and who counts as a friend.
 *
 * The two are on one screen because one is the answer to the other: "friends
 * only" is meaningless until there is a list, and a list of friends that decided
 * nothing would be an address book nobody would keep.
 *
 * The reciprocity of read receipts is said in the copy rather than left to be
 * discovered, and so is the administrator exception. A privacy screen that
 * quietly does something other than what it says is worse than one that offers
 * less.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { Loader2 } from "lucide-react";
import { Button, Card, CardBody, SegmentedControl } from "@polaris/ui";
import { savePrivacyAction } from "./actions";

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
                <CardBody className="flex flex-col gap-5 p-4">
                    {(["discoverable", "lastSeen", "readReceipts", "avatar"] as const).map((field) => (
                        <div key={field} className="flex flex-col gap-1.5">
                            <span className="text-sm font-medium">
                                {core.PRIVACY_FIELD_LABELS[field]}
                            </span>
                            <SegmentedControl
                                size="sm"
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
                            <span className="text-xs text-muted-foreground">
                                {core.PRIVACY_FIELD_NOTES[field]}
                            </span>
                        </div>
                    ))}

                    <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
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
                        <Button onClick={() => void save()} disabled={!dirty || saving}>
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
