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
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setChatRulesAction } from "./actions";
import {
    Button,
    Card,
    CardBody,
    Input,
    SegmentedControl,
    SizeField,
    Switch,
    cn
} from "@polaris/ui";

type Rules = core.ChatRules;
type Scope = core.ChatRuleScope;

export function ChatRulesView({ initial }: { initial: Record<Scope, Rules> }) {
    const t = useTranslations("admin");
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
                // Its own width. The page is a column, so without this the
                // picker is stretched to the whole content area and three short
                // words sit in a track as wide as the screen.
                className="self-start"
                aria-label={t("chat.rules.scopePicker")}
                value={scope}
                onValueChange={(next) => setScope(next)}
                options={core.CHAT_RULE_SCOPES.map((entry) => ({
                    value: entry,
                    label: (
                        <span className="flex items-center gap-1.5">
                            {t(`chat.rules.scopes.${entry}.label`)}
                            {JSON.stringify(draft[entry]) !== JSON.stringify(saved[entry]) && (
                                <span
                                    aria-label={t("chat.rules.unsaved")}
                                    className="size-1.5 rounded-full bg-primary"
                                />
                            )}
                        </span>
                    ),
                    title: t(`chat.rules.scopes.${entry}.note`)
                }))}
            />

            <p className="text-sm text-muted-foreground">{t(`chat.rules.scopes.${scope}.note`)}</p>

            <Card>
                {/* Keyed by scope, which is what makes the fields belong to the
                    tab above them. A number field holds the text it is being
                    typed into - it has to, or a half-typed "1" is read as the
                    limit - and that text was seeded once and never taken back,
                    so switching tab left the previous scope's numbers on screen
                    under the new scope's name. A limit set to 100 under one tab
                    then read as saved under another, with 25 still stored. The
                    drafts live above these fields, so remounting them shows this
                    scope's own draft rather than losing anything. */}
                <CardBody key={scope} className="flex flex-col gap-5 p-4">
                    <Limit
                        label={t("chat.rules.fields.maxMessageLength.label")}
                        hint={t("chat.rules.fields.maxMessageLength.hint")}
                        suffix={t("chat.rules.fields.maxMessageLength.suffix")}
                        value={rules.maxMessageLength}
                        min={1}
                        max={core.MAX_CHAT_MESSAGE}
                        onChange={(value) => set("maxMessageLength", value)}
                    />

                    <Limit
                        label={t("chat.rules.fields.maxPerMinute.label")}
                        hint={t("chat.rules.fields.maxPerMinute.hint")}
                        suffix={t("chat.rules.fields.maxPerMinute.suffix")}
                        zeroLabel={t("chat.rules.noLimit")}
                        value={rules.maxPerMinute}
                        min={0}
                        max={core.CHAT_RATE_CEILING}
                        onChange={(value) => set("maxPerMinute", value)}
                    />

                    <div className="flex flex-col gap-4 rounded-md border border-border p-3">
                        <Toggle
                            label={t("chat.rules.fields.spamGuard.label")}
                            hint={t("chat.rules.fields.spamGuard.hint")}
                            checked={rules.spamGuard}
                            onChange={(value) => set("spamGuard", value)}
                        />
                        <Limit
                            label={t("chat.rules.fields.maxRoomMentionsPerHour.label")}
                            hint={t("chat.rules.fields.maxRoomMentionsPerHour.hint")}
                            suffix={t("chat.rules.fields.maxRoomMentionsPerHour.suffix")}
                            zeroLabel={t("chat.rules.noLimit")}
                            value={rules.maxRoomMentionsPerHour}
                            min={0}
                            max={core.CHAT_SPAM_CEILINGS.roomMentionsPerHour}
                            disabled={!rules.spamGuard}
                            onChange={(value) => set("maxRoomMentionsPerHour", value)}
                        />
                        <Limit
                            label={t("chat.rules.fields.maxMentionsPerMessage.label")}
                            hint={t("chat.rules.fields.maxMentionsPerMessage.hint")}
                            suffix={t("chat.rules.fields.maxMentionsPerMessage.suffix")}
                            zeroLabel={t("chat.rules.noLimit")}
                            value={rules.maxMentionsPerMessage}
                            min={0}
                            max={core.CHAT_SPAM_CEILINGS.mentionsPerMessage}
                            disabled={!rules.spamGuard}
                            onChange={(value) => set("maxMentionsPerMessage", value)}
                        />
                        <Limit
                            label={t("chat.rules.fields.maxSamePersonMentions.label")}
                            hint={t("chat.rules.fields.maxSamePersonMentions.hint")}
                            suffix={t("chat.rules.fields.maxSamePersonMentions.suffix")}
                            zeroLabel={t("chat.rules.noLimit")}
                            value={rules.maxSamePersonMentions}
                            min={0}
                            max={core.CHAT_SPAM_CEILINGS.samePersonMentions}
                            disabled={!rules.spamGuard}
                            onChange={(value) => set("maxSamePersonMentions", value)}
                        />
                        <Limit
                            label={t("chat.rules.fields.maxRepeatedMessages.label")}
                            hint={t("chat.rules.fields.maxRepeatedMessages.hint")}
                            suffix={t("chat.rules.fields.maxRepeatedMessages.suffix")}
                            zeroLabel={t("chat.rules.noLimit")}
                            value={rules.maxRepeatedMessages}
                            min={0}
                            max={core.CHAT_SPAM_CEILINGS.repeatedMessages}
                            disabled={!rules.spamGuard}
                            onChange={(value) => set("maxRepeatedMessages", value)}
                        />
                    </div>

                    <Limit
                        label={t("chat.rules.fields.maxAttachments.label")}
                        hint={t("chat.rules.fields.maxAttachments.hint")}
                        suffix={t("chat.rules.fields.maxAttachments.suffix")}
                        zeroLabel={t("chat.rules.fields.maxAttachments.zero")}
                        value={rules.maxAttachments}
                        min={0}
                        max={core.CHAT_ATTACHMENT_COUNT_CEILING}
                        onChange={(value) => set("maxAttachments", value)}
                    />

                    <label
                        className={cn(
                            "flex flex-col gap-1.5",
                            rules.maxAttachments === 0 && "opacity-50"
                        )}
                    >
                        <span className="text-sm font-medium">{t("chat.rules.fields.maxAttachmentMib.label")}</span>
                        <SizeField
                            value={rules.maxAttachmentMib}
                            stored="MB"
                            min={1}
                            max={core.CHAT_ATTACHMENT_CEILING_MIB}
                            disabled={rules.maxAttachments === 0}
                            aria-label={t("chat.rules.fields.maxAttachmentMib.label")}
                            onChange={(value) => set("maxAttachmentMib", value)}
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("chat.rules.fields.maxAttachmentMib.hint")}
                        </span>
                    </label>

                    <Limit
                        label={t("chat.rules.fields.editWindowMinutes.label")}
                        hint={t("chat.rules.fields.editWindowMinutes.hint")}
                        suffix={t("chat.rules.fields.editWindowMinutes.suffix")}
                        zeroLabel={t("chat.rules.fields.editWindowMinutes.zero")}
                        value={rules.editWindowMinutes}
                        min={0}
                        max={core.CHAT_EDIT_WINDOW_CEILING_MINUTES}
                        onChange={(value) => set("editWindowMinutes", value)}
                    />

                    <Toggle
                        label={t("chat.rules.fields.deleteLeavesTrace.label")}
                        hint={t("chat.rules.fields.deleteLeavesTrace.hint")}
                        checked={rules.deleteLeavesTrace}
                        onChange={(value) => set("deleteLeavesTrace", value)}
                    />

                    <Toggle
                        label={t("chat.rules.fields.keepEditHistory.label")}
                        hint={t("chat.rules.fields.keepEditHistory.hint")}
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
                            {t(`chat.rules.scopes.${scope}.save`)}
                        </Button>
                        {!dirty && <span className="text-xs text-muted-foreground">{t("chat.rules.saved")}</span>}
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
    const t = useTranslations("admin");
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
                {valid ? hint : t("chat.rules.range", { min: String(min), max: String(max) })}
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
