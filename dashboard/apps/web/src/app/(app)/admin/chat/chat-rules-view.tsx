"use client";

/**
 * The house rules, one kind of conversation at a time.
 *
 * A picker rather than three forms down the page: the fields are identical, and
 * three copies of the same seven controls is a screen nobody reads. Switching
 * scope keeps whatever has been typed in the other two, so an admin who wants
 * the same limits everywhere sets them, saves, switches and saves again without
 * retyping - and one that is still unsaved says so, because losing a typed limit
 * to a click on a tab is the failure this screen would otherwise have.
 */

import * as core from "@polaris/core";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { runAction } from "@/lib/run-action";
import { setChatRulesAction } from "./actions";
import { Button, Card, CardBody, Input, SegmentedControl, Switch, cn } from "@polaris/ui";

type Rules = core.ChatRules;
type Scope = core.ChatRuleScope;

export function ChatRulesView({ initial }: { initial: Record<Scope, Rules> }) {
    const [scope, setScope] = useState<Scope>("space");
    const [draft, setDraft] = useState<Record<Scope, Rules>>(initial);
    const [saved, setSaved] = useState<Record<Scope, Rules>>(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const rules = draft[scope];
    const dirty = useMemo(
        () => JSON.stringify(draft[scope]) !== JSON.stringify(saved[scope]),
        [draft, saved, scope]
    );

    const set = <K extends keyof Rules>(key: K, value: Rules[K]) => {
        setError("");
        setDraft((current) => ({ ...current, [scope]: { ...current[scope], [key]: value } }));
    };

    const save = async () => {
        if (saving || !dirty) return;
        setSaving(true);
        setError("");
        const result = await runAction(() => setChatRulesAction(scope, rules), setError);
        setSaving(false);
        if (result?.error) return;
        setSaved((current) => ({ ...current, [scope]: rules }));
    };

    return (
        <div className="flex flex-col gap-4">
            <SegmentedControl
                aria-label="Which conversations these rules cover"
                value={scope}
                onValueChange={(next) => setScope(next)}
                options={core.CHAT_RULE_SCOPES.map((entry) => ({
                    value: entry,
                    label: (
                        <span className="flex items-center gap-1.5">
                            {core.CHAT_RULE_SCOPE_LABELS[entry]}
                            {JSON.stringify(draft[entry]) !== JSON.stringify(saved[entry]) && (
                                <span
                                    aria-label="Unsaved changes"
                                    className="size-1.5 rounded-full bg-primary"
                                />
                            )}
                        </span>
                    ),
                    title: core.CHAT_RULE_SCOPE_NOTES[entry]
                }))}
            />

            <p className="text-sm text-muted-foreground">{core.CHAT_RULE_SCOPE_NOTES[scope]}</p>

            <Card>
                <CardBody className="flex flex-col gap-5 p-4">
                    <Limit
                        label="Longest message"
                        hint="Characters. Somebody with more to say than this has a note or a snippet."
                        suffix="characters"
                        value={rules.maxMessageLength}
                        min={1}
                        max={core.MAX_CHAT_MESSAGE}
                        onChange={(value) => set("maxMessageLength", value)}
                    />

                    <Limit
                        label="Messages a minute"
                        hint="Per person, per conversation. Zero for as many as they can type."
                        suffix="a minute"
                        zeroLabel="No limit."
                        value={rules.maxPerMinute}
                        min={0}
                        max={core.CHAT_RATE_CEILING}
                        onChange={(value) => set("maxPerMinute", value)}
                    />

                    <Limit
                        label="Files on one message"
                        hint="Zero stops files being sent in this kind of conversation at all."
                        suffix="files"
                        zeroLabel="Files cannot be sent here."
                        value={rules.maxAttachments}
                        min={0}
                        max={core.CHAT_ATTACHMENT_COUNT_CEILING}
                        onChange={(value) => set("maxAttachments", value)}
                    />

                    <Limit
                        label="Biggest single file"
                        hint="Anything larger belongs in Drive, with a link to it in the conversation."
                        suffix="MB"
                        value={rules.maxAttachmentMib}
                        min={1}
                        max={core.CHAT_ATTACHMENT_CEILING_MIB}
                        disabled={rules.maxAttachments === 0}
                        onChange={(value) => set("maxAttachmentMib", value)}
                    />

                    <Limit
                        label="How long a message stays editable"
                        hint="Minutes after it was sent. Zero means always, which is what people expect. It covers deleting too, and never binds somebody moderating the room."
                        suffix="minutes"
                        zeroLabel="Always editable."
                        value={rules.editWindowMinutes}
                        min={0}
                        max={core.CHAT_EDIT_WINDOW_CEILING_MINUTES}
                        onChange={(value) => set("editWindowMinutes", value)}
                    />

                    <Toggle
                        label="Deleting leaves a line saying so"
                        hint="On, a deleted message reads 'This message was deleted' and replies under it still make sense. Off, the message and its files go without trace - except for one that has replies hanging off it, which would take them with it."
                        checked={rules.deleteLeavesTrace}
                        onChange={(value) => set("deleteLeavesTrace", value)}
                    />

                    <Toggle
                        label="Keep what a message said before it was edited"
                        hint="On, '(edited)' opens the earlier versions for anybody who can read the message. Off, no earlier version is recorded from then on."
                        checked={rules.keepEditHistory}
                        onChange={(value) => set("keepEditHistory", value)}
                    />

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}

                    <div className="flex items-center gap-3">
                        <Button onClick={() => void save()} disabled={!dirty || saving}>
                            {saving && <Loader2 className="size-4 animate-spin" />}
                            Save {core.CHAT_RULE_SCOPE_LABELS[scope].toLowerCase()}
                        </Button>
                        {!dirty && <span className="text-xs text-muted-foreground">Saved.</span>}
                    </div>
                </CardBody>
            </Card>
        </div>
    );
}

/**
 * A whole number with a ceiling.
 *
 * Held as a string while it is being typed, because a controlled number field
 * that coerces on every keystroke cannot be emptied to type a new value - the
 * zero it snaps back to fights the cursor.
 */
function Limit({
    label,
    hint,
    suffix,
    zeroLabel,
    value,
    min,
    max,
    disabled,
    onChange
}: {
    label: string;
    hint: string;
    suffix: string;
    /** What zero means, said in words, when the field is on it. */
    zeroLabel?: string;
    value: number;
    min: number;
    max: number;
    disabled?: boolean;
    onChange: (value: number) => void;
}) {
    const [text, setText] = useState(String(value));
    const typed = Number(text);
    const valid = Number.isInteger(typed) && typed >= min && typed <= max;

    return (
        <label className={cn("flex flex-col gap-1.5", disabled && "opacity-50")}>
            <span className="text-sm font-medium">{label}</span>
            <div className="flex items-center gap-2">
                <Input
                    type="number"
                    inputMode="numeric"
                    min={min}
                    max={max}
                    value={text}
                    disabled={disabled}
                    className="w-32"
                    onChange={(event) => {
                        setText(event.target.value);
                        const next = Number(event.target.value);
                        if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
                    }}
                />
                <span className="text-sm text-muted-foreground">{suffix}</span>
                {value === 0 && zeroLabel && (
                    <span className="text-xs text-muted-foreground">{zeroLabel}</span>
                )}
            </div>
            <span className={cn("text-xs", valid ? "text-muted-foreground" : "text-danger")}>
                {valid ? hint : `A whole number between ${min} and ${max}.`}
            </span>
        </label>
    );
}

function Toggle({
    label,
    hint,
    checked,
    onChange
}: {
    label: string;
    hint: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <Switch checked={checked} onChange={onChange} aria-label={label} />
        </div>
    );
}
