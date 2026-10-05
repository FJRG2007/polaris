"use client";

/**
 * One filter, laid out as it runs: WHEN a message arrives, IF these groups of
 * conditions hold, THEN these steps, in order - as a column of cards joined by a
 * line, or as a diagram of the same nodes. The same editor Places draws its
 * device automations with (`@polaris/ui/automation`, `@polaris/ui/automation-canvas`),
 * with Mail's own fields in the cards.
 *
 * Checked as it is typed, against the same schema the server runs
 * (`mailFilterSchema`), so a problem is said under the field it is about. A
 * field not filled in yet is unfinished rather than wrong: it carries a `*`,
 * Save waits, and only pressing Save anyway says which ones are missing.
 */

import * as core from "@polaris/core";
import * as flow from "@polaris/ui/automation";
import type { MailRuleView } from "@/lib/mailbox/rules";
import type { MailLabelView } from "@/lib/mailbox/labels";
import type { MailFolderView } from "@/lib/mailbox/views";
import { mailRefusalText } from "@/lib/mailbox/refusal-text";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowLeft, Filter, Loader2, Play, Zap } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { swap, within, type Path } from "@polaris/ui/automation-graph";
import { Button, Input, SegmentedControl, Switch, cn } from "@polaris/ui";
import {
    FlowCanvas,
    type CanvasSelection,
    type FlowVocabulary,
    type NodeState
} from "@polaris/ui/automation-canvas";
import * as words from "./filter-words";
import { GroupCard, StepCard, TriggerCard } from "./filter-cards";

/** A filter while it is being edited: the input the server takes. */
export interface FilterDraft {
    readonly name: string;
    readonly enabled: boolean;
    readonly definition: core.MailFilterDefinition;
    readonly applyToExisting: boolean;
}

/** A complaint at a place in the draft. */
export interface FilterIssue {
    readonly path: readonly (string | number)[];
    readonly message: string;
}

/** Where the reader's choice of layout is kept, in this browser only. */
const LAYOUT_KEY = "polaris.mail.filterLayout";

/** Complaints that mean "not filled in yet" rather than "wrong", which wait for
 *  a press of Save before they are said. */
const UNFINISHED = new Set([
    "Give the rule a name",
    "Say what to look for",
    "Name the header",
    "Choose a folder",
    "Choose a label",
    "Choose where to send it",
    "A group needs a condition",
    "Add something to match on",
    "Say what should happen"
]);

/** What `rules.ts` refuses a forward with, as the catalog's key for it. */
const FORWARD_LOOP = "That address is a mailbox here. Forwarding to it would loop."; // i18n-ignore
const FORWARD_UNVERIFIED = "Forward only to an address you have verified on your account."; // i18n-ignore

function pathKey(path: readonly (string | number)[]): string {
    return path.join(".");
}

/** What is compared to decide whether there is anything to save. Asking for a
 *  run over the inbox is something to save on its own: it is how a filter that
 *  is already right is applied to the mail that arrived before it. */
function snapshot(draft: FilterDraft): string {
    return JSON.stringify({
        name: core.normalizeMailName(draft.name),
        enabled: draft.enabled,
        definition: draft.definition,
        applyToExisting: draft.applyToExisting
    });
}

export function draftOf(rule: MailRuleView): FilterDraft {
    return {
        name: rule.name,
        enabled: rule.enabled,
        definition: rule.definition,
        applyToExisting: false
    };
}

export function FilterEditor({
    initial,
    isNew,
    folders,
    labels,
    forwardTargets,
    mailboxAddresses,
    serverIssues,
    serverError,
    onSave,
    onClose
}: {
    initial: FilterDraft;
    /** Nothing saved yet: Save is there to press from the first moment. */
    isNew: boolean;
    folders: readonly MailFolderView[];
    labels: readonly MailLabelView[];
    /** The addresses a forward may go to: the reader's verified ones. */
    forwardTargets: readonly string[];
    /** Every mailbox here, which a forward may not go to. */
    mailboxAddresses: readonly string[];
    /** What the server said about the last save, when it refused it. */
    serverIssues: readonly FilterIssue[];
    serverError: string;
    onSave: (draft: FilterDraft) => void;
    onClose: () => void;
}) {
    const t = useTranslations("mailSettings");
    const tm = useTranslations("mail");
    const [draft, setDraft] = useState<FilterDraft>(initial);
    const [saved] = useState(() => (isNew ? "" : snapshot(initial)));
    const [attempted, setAttempted] = useState(serverIssues.length > 0);
    const [answered, setAnswered] = useState<readonly FilterIssue[]>(serverIssues);
    const [layout, chooseLayout] = flow.useFlowLayout(LAYOUT_KEY);
    const definition = draft.definition;
    const dirty = snapshot(draft) !== saved;

    /** Every complaint about the draft as it stands: the schema's, then the ones
     *  about where a forward goes, which the schema cannot know. */
    const issues = useMemo<FilterIssue[]>(() => {
        const parsed = core.mailFilterSchema.safeParse(draft);
        const found: FilterIssue[] = parsed.success
            ? []
            : parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
        draft.definition.actions.forEach((step, index) => {
            if (step.kind !== "forward" || !step.to.trim()) return;
            const path = ["definition", "actions", index, "to"];
            // The server's own refusals, word for word, so `mailRefusalText` says
            // them in the reader's language and the server's answer matches.
            const message = mailboxAddresses.some((one) => core.sameAddress(one, step.to))
                ? FORWARD_LOOP
                : forwardTargets.some((one) => core.sameAddress(one, step.to))
                  ? ""
                  : FORWARD_UNVERIFIED;
            if (message) found.push({ path, message });
        });
        return found;
    }, [draft, forwardTargets, mailboxAddresses]);

    const issueLookup = useMemo<flow.IssueLookup>(() => {
        const found = new Map<string, string>();
        for (const issue of issues) {
            const key = pathKey(issue.path);
            if (found.has(key)) continue;
            if (!attempted && UNFINISHED.has(issue.message)) continue;
            found.set(key, mailRefusalText(tm, issue.message));
        }
        for (const issue of answered)
            if (!found.has(pathKey(issue.path))) found.set(pathKey(issue.path), issue.message);
        return (path) => found.get(pathKey(path));
    }, [issues, answered, attempted, tm]);

    /** How a node stands, for the canvas to mark it: wrong as soon as it is,
     *  merely unfinished until Save is pressed - the same split the fields make. */
    const stateOf = useCallback(
        (path: Path): NodeState => {
            let state: NodeState = "ok";
            for (const issue of [...issues, ...answered]) {
                if (!within(issue.path, path)) continue;
                if (attempted || !UNFINISHED.has(issue.message)) return "invalid";
                state = "incomplete";
            }
            return state;
        },
        [issues, answered, attempted]
    );

    const edit = (change: (current: FilterDraft) => FilterDraft) => {
        setAnswered([]);
        setDraft(change);
    };
    const editDefinition = (
        change: (current: core.MailFilterDefinition) => core.MailFilterDefinition
    ) => edit((current) => ({ ...current, definition: change(current.definition) }));

    const lookup = useMemo<words.FilterLookup>(
        () => ({
            folderName: (id) => folders.find((folder) => folder.id === id)?.name,
            labelName: (id) => labels.find((label) => label.id === id)?.name
        }),
        [folders, labels]
    );

    const vocabulary = useMemo<FlowVocabulary<core.MailFilterDefinition>>(
        () => ({
            labels: {
                when: t("rules.editor.when"),
                if: t("rules.editor.if"),
                then: t("rules.editor.then"),
                allGroups: t("rules.editor.allGroups"),
                anyGroup: t("rules.editor.anyGroup"),
                allOf: t("rules.editor.allOf"),
                anyOf: t("rules.editor.anyOf"),
                addTrigger: t("rules.editor.addCondition"),
                addCondition: t("rules.editor.addCondition"),
                addStep: t("rules.editor.addStep"),
                tooMany: t("rules.editor.tooMany"),
                diagram: t("rules.canvas.diagram"),
                add: t("rules.canvas.add"),
                toGroup: t("rules.canvas.toGroup"),
                newGroup: t("rules.canvas.newGroup"),
                zoomIn: t("rules.canvas.zoomIn"),
                zoomOut: t("rules.canvas.zoomOut"),
                fit: t("rules.canvas.fit"),
                always: t("rules.canvas.always"),
                oneGroup: t("rules.canvas.oneGroup"),
                group: (number) => t("rules.canvas.group", { number }),
                unfinished: t("rules.canvas.unfinished"),
                invalid: t("rules.canvas.invalid"),
                pick: t("rules.canvas.pick"),
                inspector: t("rules.canvas.inspector"),
                close: t("rules.canvas.close"),
                reorderHint: t("rules.canvas.reorderHint"),
                nodeHelp: t("rules.canvas.nodeHelp"),
                nodeHelpReadOnly: t("rules.canvas.nodeHelpReadOnly"),
                moved: t("rules.canvas.moved"),
                handle: t("rules.canvas.handle"),
                edgeHelp: t("rules.canvas.edgeHelp")
            },
            triggers: {
                kinds: ["arrival"],
                kindText: () => t("rules.trigger.arrival"),
                blank: () => ({ id: core.automationNodeId(), kind: "arrival" }),
                describe: () => t("rules.trigger.everyMessage"),
                fixed: true
            },
            conditions: {
                kinds: words.CONDITION_KINDS,
                kindText: (kind) => words.conditionKindText(kind, t),
                blank: words.blankCondition,
                describe: (condition) => words.describeCondition(condition, t)
            },
            steps: {
                kinds: words.STEP_KINDS,
                kindText: (kind) => words.stepKindText(kind, t),
                blank: words.blankStep,
                describe: (step) => words.describeStep(step, lookup, t)
            },
            limits: {
                triggers: 1,
                groups: core.MAIL_FILTER_LIMITS.groups,
                conditionsPerGroup: core.MAIL_FILTER_LIMITS.conditionsPerGroup,
                steps: core.MAIL_FILTER_LIMITS.steps
            },
            newId: core.automationNodeId
        }),
        [t, lookup]
    );

    const blocked = issues.length > 0 || !dirty;
    const save = () => {
        setAttempted(true);
        if (blocked) return;
        onSave({ ...draft, name: core.normalizeMailName(draft.name) });
    };

    const triggerCard = <TriggerCard />;

    const groupCard = (group: core.MailFilterGroup, index: number, handle?: ReactNode) => (
        <GroupCard
            key={group.id}
            handle={handle}
            group={group}
            path={["definition", "conditions", "groups", index]}
            disabled={false}
            attempted={attempted}
            onChange={(next) =>
                editDefinition((current) => ({
                    ...current,
                    conditions: {
                        ...current.conditions,
                        groups: current.conditions.groups.map((entry, at) =>
                            at === index ? next : entry
                        )
                    }
                }))
            }
            onRemove={() =>
                editDefinition((current) => ({
                    ...current,
                    conditions: {
                        ...current.conditions,
                        groups: current.conditions.groups.filter((_, at) => at !== index)
                    }
                }))
            }
        />
    );

    const stepCard = (step: core.MailFilterStep, index: number, handle?: ReactNode) => (
        <StepCard
            key={step.id}
            handle={handle}
            step={step}
            number={index + 1}
            path={["definition", "actions", index]}
            folders={folders}
            labels={labels}
            forwardTargets={forwardTargets}
            disabled={false}
            onChange={(next) =>
                editDefinition((current) => ({
                    ...current,
                    actions: current.actions.map((entry, at) => (at === index ? next : entry))
                }))
            }
            onRemove={() =>
                editDefinition((current) => ({
                    ...current,
                    actions: current.actions.filter((_, at) => at !== index)
                }))
            }
            onUp={
                index > 0
                    ? () =>
                          editDefinition((current) => ({
                              ...current,
                              actions: swap(current.actions, index, -1)
                          }))
                    : undefined
            }
            onDown={
                index < definition.actions.length - 1
                    ? () =>
                          editDefinition((current) => ({
                              ...current,
                              actions: swap(current.actions, index, 1)
                          }))
                    : undefined
            }
        />
    );

    const groupsMatch = definition.conditions.groups.length > 1 && (
        <flow.MatchPicker
            value={definition.conditions.match}
            label={t("rules.editor.groupsMatch")}
            allLabel={t("rules.editor.allGroups")}
            anyLabel={t("rules.editor.anyGroup")}
            onChange={(match) =>
                editDefinition((current) => ({
                    ...current,
                    conditions: { ...current.conditions, match }
                }))
            }
        />
    );

    const addGroup = (kind: string) =>
        editDefinition((current) => ({
            ...current,
            conditions: {
                ...current.conditions,
                groups: [
                    ...current.conditions.groups,
                    {
                        id: core.automationNodeId(),
                        match: "all",
                        items: [words.blankCondition(kind as core.MailRuleField)]
                    }
                ]
            }
        }));

    /** What the canvas opens for its selected node: the form's own card. */
    const inspect = (selection: CanvasSelection): ReactNode => {
        switch (selection.role) {
            case "trigger":
                return triggerCard;
            case "group": {
                const group = definition.conditions.groups[selection.index];
                return group ? groupCard(group, selection.index) : null;
            }
            case "step": {
                const step = definition.actions[selection.index];
                return step ? stepCard(step, selection.index) : null;
            }
            case "gate":
                return (
                    <div className="flex flex-col gap-2">
                        <p className="text-xs text-muted-foreground">{t("rules.editor.ifHint")}</p>
                        {groupsMatch}
                    </div>
                );
        }
    };

    const stageIssue = (path: Path) => (attempted ? issueLookup(path) : undefined);
    const stageIssues = [
        stageIssue(["definition", "conditions", "groups"]),
        stageIssue(["definition", "conditions"]),
        stageIssue(["definition", "actions"])
    ].filter((issue): issue is string => issue !== undefined);

    return (
        <flow.IssueProvider value={issueLookup}>
            <div className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="ghost" className="px-2" onClick={onClose}>
                        <ArrowLeft className="size-4 shrink-0" />
                        {t("rules.editor.back")}
                    </Button>
                    <span className="flex-1" />
                    <SegmentedControl<flow.FlowLayout>
                        size="sm"
                        value={layout}
                        onValueChange={chooseLayout}
                        aria-label={t("rules.canvas.layout")}
                        options={[
                            { value: "form", label: t("rules.canvas.form") },
                            { value: "visual", label: t("rules.canvas.visual") }
                        ]}
                    />
                </div>

                <div className="flex flex-wrap items-end gap-3">
                    <flow.Field
                        label={t("rules.name")}
                        path={["name"]}
                        required
                        className="min-w-[12rem] flex-1"
                    >
                        {(id, invalid) => (
                            <Input
                                id={id}
                                value={draft.name}
                                maxLength={80}
                                placeholder={t("rules.namePlaceholder")}
                                aria-invalid={invalid || undefined}
                                onChange={(event) =>
                                    edit((current) => ({ ...current, name: event.target.value }))
                                }
                            />
                        )}
                    </flow.Field>
                    <label className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                            checked={draft.enabled}
                            aria-label={t("rules.editor.enabled")}
                            onChange={(enabled) => edit((current) => ({ ...current, enabled }))}
                        />
                        {draft.enabled ? t("rules.on") : t("rules.off")}
                    </label>
                    <Button
                        size="sm"
                        aria-disabled={blocked || undefined}
                        className={cn(blocked && "opacity-60")}
                        title={!dirty ? t("rules.editor.nothingToSave") : undefined}
                        onClick={save}
                    >
                        {t("rules.save")}
                    </Button>
                </div>

                {serverError && (
                    <p
                        role="alert"
                        className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                    >
                        {serverError}
                    </p>
                )}

                {layout === "visual" ? (
                    <FlowCanvas
                        definition={definition}
                        vocabulary={vocabulary}
                        readOnly={false}
                        onChange={editDefinition}
                        stateOf={stateOf}
                        renderInspector={inspect}
                        stageIssues={stageIssues}
                        // Mail's settings column is narrow: the card goes
                        // under the diagram so the diagram gets the width.
                        inspectorPlacement="below"
                    />
                ) : (
                    <ol className="flex min-w-0 flex-col">
                        <flow.Stage
                            icon={<Zap className="size-4" />}
                            title={t("rules.editor.when")}
                            hint={t("rules.editor.whenHint")}
                        >
                            {triggerCard}
                        </flow.Stage>
                        <flow.Stage
                            icon={<Filter className="size-4" />}
                            title={t("rules.editor.if")}
                            hint={t("rules.editor.ifHint")}
                            issue={
                                stageIssue(["definition", "conditions", "groups"]) ??
                                stageIssue(["definition", "conditions"])
                            }
                        >
                            {groupsMatch}
                            <flow.SortableList
                                items={definition.conditions.groups}
                                label={t("rules.editor.groupsList")}
                                handleLabel={t("rules.editor.reorder")}
                                onMove={(from, to) =>
                                    editDefinition((current) => ({
                                        ...current,
                                        conditions: {
                                            ...current.conditions,
                                            groups: flow.moved(current.conditions.groups, from, to)
                                        }
                                    }))
                                }
                            >
                                {groupCard}
                            </flow.SortableList>
                            {definition.conditions.groups.length <
                                core.MAIL_FILTER_LIMITS.groups && (
                                <flow.AddMenu
                                    label={
                                        definition.conditions.groups.length === 0
                                            ? t("rules.editor.addCondition")
                                            : t("rules.editor.addGroup")
                                    }
                                    options={words.CONDITION_KINDS.map((kind) => ({
                                        value: kind,
                                        label: words.conditionKindText(kind, t)
                                    }))}
                                    onPick={addGroup}
                                />
                            )}
                        </flow.Stage>
                        <flow.Stage
                            icon={<Play className="size-4" />}
                            title={t("rules.editor.then")}
                            hint={t("rules.editor.thenHint")}
                            issue={stageIssue(["definition", "actions"])}
                            last
                        >
                            <flow.SortableList
                                items={definition.actions}
                                label={t("rules.editor.stepsList")}
                                handleLabel={t("rules.editor.reorder")}
                                onMove={(from, to) =>
                                    editDefinition((current) => ({
                                        ...current,
                                        actions: flow.moved(current.actions, from, to)
                                    }))
                                }
                            >
                                {stepCard}
                            </flow.SortableList>
                            {definition.actions.length < core.MAIL_FILTER_LIMITS.steps && (
                                <flow.AddMenu
                                    label={t("rules.editor.addStep")}
                                    options={words.STEP_KINDS.map((kind) => ({
                                        value: kind,
                                        label: words.stepKindText(kind, t)
                                    }))}
                                    onPick={(kind) =>
                                        editDefinition((current) => ({
                                            ...current,
                                            actions: [
                                                ...current.actions,
                                                words.blankStep(kind as core.MailFilterStepKind)
                                            ]
                                        }))
                                    }
                                />
                            )}
                        </flow.Stage>
                    </ol>
                )}
            </div>
        </flow.IssueProvider>
    );
}

/** The spinner a row shows while its save is on the way. */
export function Saving() {
    return <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />;
}
