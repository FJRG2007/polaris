"use client";

/**
 * The filter of a view: rules on fields, joined by "all of" or "any of", and
 * groups of rules joined their own way. Every change is the view's at once - the
 * list narrows as soon as a rule is whole; one still being written waits.
 */

import { unwrap } from "./call";
import { useCrmT } from "./i18n";
import * as actions from "../actions/records";
import { parseAmount } from "../model/values";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MemberLine, OptionChip, RefChip } from "./cell-display";
import { Check, ChevronDown, ListFilter, Plus, Trash2, X } from "lucide-react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input,
    MenuSearch,
    menuSearchMatches,
    Select
} from "@polaris/ui";
import { FIELDS, fieldOf, type CrmObject, type FieldDef, type Ref } from "../model/objects";
import * as filters from "../model/filters";

let made = 0;
/** An id for a rule or group, unique on this page. Not `crypto.randomUUID`,
 *  which a dashboard reached over plain http does not have. */
function localId(): string {
    made += 1;
    return `${Date.now().toString(36)}${made.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function newRule(object: CrmObject): filters.FilterRule {
    const field = FIELDS[object][0]!;
    return {
        id: localId(),
        key: field.key,
        operator: filters.operatorsFor(field.kind)[0]!,
        value: null
    };
}

function countRules(filter: filters.ViewFilter): number {
    return filter.rules.reduce(
        (sum, item) => sum + (filters.isGroup(item) ? item.rules.length : 1),
        0
    );
}

export function FilterButton({
    object,
    filter,
    people,
    onChange,
    disabled
}: {
    object: CrmObject;
    filter: filters.ViewFilter;
    people: readonly Ref[];
    onChange: (filter: filters.ViewFilter) => void;
    disabled?: boolean;
}) {
    const t = useCrmT();
    const [open, setOpen] = useState(false);
    const active = filters.activeRules(object, filter);
    return (
        <>
            <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => setOpen(true)}
                className={cn(active > 0 && "border-primary text-foreground")}
            >
                <ListFilter className="size-4" />
                {t("filters.button")}
                {active > 0 ? (
                    <span className="rounded bg-primary/10 px-1 text-[0.75rem] tabular-nums text-primary">
                        {active}
                    </span>
                ) : null}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{t("filters.title")}</DialogTitle>
                        <DialogDescription>{t("filters.description")}</DialogDescription>
                    </DialogHeader>
                    <FilterEditor
                        object={object}
                        filter={filter}
                        people={people}
                        onChange={onChange}
                    />
                    <DialogFooter>
                        {filter.rules.length > 0 ? (
                            <Button
                                variant="ghost"
                                className="mr-auto"
                                onClick={() => onChange(filters.EMPTY_FILTER)}
                            >
                                {t("filters.clearAll")}
                            </Button>
                        ) : null}
                        <Button onClick={() => setOpen(false)}>{t("filters.done")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

function ConjunctionPicker({
    value,
    onChange,
    label
}: {
    value: filters.Conjunction;
    onChange: (value: filters.Conjunction) => void;
    label: string;
}) {
    const t = useCrmT();
    return (
        <Select
            value={value}
            onValueChange={(next) => onChange(next as filters.Conjunction)}
            aria-label={label}
            className="h-8 w-auto min-w-0"
            options={filters.CONJUNCTIONS.map((one) => ({
                value: one,
                label: t(`filters.match.${one}`)
            }))}
        />
    );
}

function FilterEditor({
    object,
    filter,
    people,
    onChange
}: {
    object: CrmObject;
    filter: filters.ViewFilter;
    people: readonly Ref[];
    onChange: (filter: filters.ViewFilter) => void;
}) {
    const t = useCrmT();
    const full = countRules(filter) >= filters.MAX_RULES;
    const setItems = (rules: filters.FilterItem[]) => onChange({ ...filter, rules });
    const replace = (id: string, next: filters.FilterItem | null) =>
        setItems(filter.rules.flatMap((item) => (item.id === id ? (next ? [next] : []) : [item])));

    return (
        <div className="flex flex-col gap-3">
            {filter.rules.length === 0 ? (
                <p className="text-[0.8125rem] text-muted-foreground">{t("filters.empty")}</p>
            ) : (
                <div className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
                    <span>{t("filters.showWhere")}</span>
                    <ConjunctionPicker
                        value={filter.conjunction}
                        onChange={(conjunction) => onChange({ ...filter, conjunction })}
                        label={t("filters.matchLabel")}
                    />
                </div>
            )}
            <ul className="flex flex-col gap-2">
                {filter.rules.map((item) => (
                    <li key={item.id}>
                        {filters.isGroup(item) ? (
                            <GroupEditor
                                object={object}
                                group={item}
                                people={people}
                                full={full}
                                onChange={(next) => replace(item.id, next)}
                            />
                        ) : (
                            <RuleEditor
                                object={object}
                                rule={item}
                                people={people}
                                onChange={(next) => replace(item.id, next)}
                            />
                        )}
                    </li>
                ))}
            </ul>
            <div className="flex flex-wrap gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    disabled={full}
                    title={full ? t("filters.full", { max: filters.MAX_RULES }) : undefined}
                    onClick={() => setItems([...filter.rules, newRule(object)])}
                >
                    <Plus className="size-4" />
                    {t("filters.addRule")}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={full}
                    title={full ? t("filters.full", { max: filters.MAX_RULES }) : undefined}
                    onClick={() =>
                        setItems([
                            ...filter.rules,
                            { id: localId(), conjunction: "or", rules: [newRule(object)] }
                        ])
                    }
                >
                    <Plus className="size-4" />
                    {t("filters.addGroup")}
                </Button>
            </div>
        </div>
    );
}

function GroupEditor({
    object,
    group,
    people,
    full,
    onChange
}: {
    object: CrmObject;
    group: filters.FilterGroup;
    people: readonly Ref[];
    full: boolean;
    onChange: (group: filters.FilterGroup | null) => void;
}) {
    const t = useCrmT();
    const setRules = (rules: filters.FilterRule[]) =>
        onChange(rules.length === 0 ? null : { ...group, rules });
    return (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
            <div className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
                <span>{t("filters.groupWhere")}</span>
                <ConjunctionPicker
                    value={group.conjunction}
                    onChange={(conjunction) => onChange({ ...group, conjunction })}
                    label={t("filters.matchLabel")}
                />
                <button
                    type="button"
                    className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground"
                    aria-label={t("filters.removeGroup")}
                    title={t("filters.removeGroup")}
                    onClick={() => onChange(null)}
                >
                    <Trash2 className="size-3.5" />
                </button>
            </div>
            <ul className="flex flex-col gap-2">
                {group.rules.map((rule) => (
                    <li key={rule.id}>
                        <RuleEditor
                            object={object}
                            rule={rule}
                            people={people}
                            onChange={(next) =>
                                setRules(
                                    group.rules.flatMap((one) =>
                                        one.id === rule.id ? (next ? [next] : []) : [one]
                                    )
                                )
                            }
                        />
                    </li>
                ))}
            </ul>
            <Button
                variant="ghost"
                size="sm"
                className="self-start"
                disabled={full}
                title={full ? t("filters.full", { max: filters.MAX_RULES }) : undefined}
                onClick={() => setRules([...group.rules, newRule(object)])}
            >
                <Plus className="size-4" />
                {t("filters.addRule")}
            </Button>
        </div>
    );
}

function RuleEditor({
    object,
    rule,
    people,
    onChange
}: {
    object: CrmObject;
    rule: filters.FilterRule;
    people: readonly Ref[];
    onChange: (rule: filters.FilterRule | null) => void;
}) {
    const t = useCrmT();
    const field = fieldOf(object, rule.key)!;
    const fieldName = (one: FieldDef) =>
        t(`fields.${object}.${one.key}` as Parameters<typeof t>[0]);
    const operand = filters.operandOf(field.kind, rule.operator);
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Select
                value={rule.key}
                aria-label={t("filters.field")}
                className="h-8 w-40 min-w-0"
                options={FIELDS[object].map((one) => ({ value: one.key, label: fieldName(one) }))}
                onValueChange={(key) => {
                    const next = fieldOf(object, key);
                    if (!next || key === rule.key) return;
                    onChange({
                        ...rule,
                        key,
                        operator: filters.operatorsFor(next.kind)[0]!,
                        value: null
                    });
                }}
            />
            <Select
                value={rule.operator}
                aria-label={t("filters.operator")}
                className="h-8 w-40 min-w-0"
                options={filters.operatorsFor(field.kind).map((one) => ({
                    value: one,
                    label: t(`filters.operators.${one}`)
                }))}
                onValueChange={(next) => {
                    const operator = next as filters.FilterOperator;
                    const keeps = filters.operandOf(field.kind, operator) === operand;
                    onChange({ ...rule, operator, value: keeps ? rule.value : null });
                }}
            />
            <div className="flex min-w-0 flex-1 basis-40">
                <ValueEditor
                    object={object}
                    field={field}
                    rule={rule}
                    people={people}
                    onChange={(value) => onChange({ ...rule, value })}
                />
            </div>
            <button
                type="button"
                className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground"
                aria-label={t("filters.removeRule")}
                title={t("filters.removeRule")}
                onClick={() => onChange(null)}
            >
                <X className="size-4" />
            </button>
        </div>
    );
}

/** A number as typed, kept as text until it reads as one. */
function NumberInput({
    value,
    onChange,
    label
}: {
    value: filters.FilterValue;
    onChange: (value: number | null) => void;
    label: string;
}) {
    const t = useCrmT();
    const [typed, setTyped] = useState(typeof value === "number" ? String(value) : "");
    const parsed = typed.trim() === "" ? null : parseAmount(typed);
    const wrong = typed.trim() !== "" && parsed === null;
    return (
        <div className="flex w-full min-w-0 flex-col gap-1">
            <Input
                value={typed}
                inputMode="decimal"
                aria-label={label}
                aria-invalid={wrong}
                placeholder={t("filters.numberPlaceholder")}
                className="h-8"
                maxLength={32}
                onChange={(event) => {
                    setTyped(event.target.value);
                    const next =
                        event.target.value.trim() === "" ? null : parseAmount(event.target.value);
                    onChange(next);
                }}
            />
            {wrong ? <p className="text-[0.6875rem] text-danger">{t("invalid.number")}</p> : null}
        </div>
    );
}

function ValueEditor({
    object,
    field,
    rule,
    people,
    onChange
}: {
    object: CrmObject;
    field: FieldDef;
    rule: filters.FilterRule;
    people: readonly Ref[];
    onChange: (value: filters.FilterValue) => void;
}) {
    const t = useCrmT();
    const label = t("filters.value");
    switch (filters.operandOf(field.kind, rule.operator)) {
        case "none":
            return null;
        case "text":
            return (
                <Input
                    value={typeof rule.value === "string" ? rule.value : ""}
                    aria-label={label}
                    placeholder={t("filters.textPlaceholder")}
                    maxLength={filters.MAX_FILTER_TEXT}
                    className="h-8"
                    onChange={(event) => onChange(event.target.value)}
                />
            );
        case "number":
            return (
                <NumberInput
                    key={rule.operator}
                    value={rule.value}
                    onChange={onChange}
                    label={label}
                />
            );
        case "day":
            return (
                <Input
                    type="date"
                    value={typeof rule.value === "string" ? rule.value : ""}
                    aria-label={label}
                    className="h-8"
                    onChange={(event) => onChange(event.target.value || null)}
                />
            );
        case "choices":
            return (
                <ChoicePicker
                    object={object}
                    field={field}
                    chosen={Array.isArray(rule.value) ? rule.value : []}
                    people={people}
                    onChange={(choices) => onChange(choices.length > 0 ? choices : null)}
                />
            );
    }
}

/** How long typing has to pause before a name is looked up. */
const LOOKUP_DELAY_MS = 200;

/** The choices of a select, the shelf's people, or records found by name. */
function useChoices(
    field: FieldDef,
    people: readonly Ref[],
    search: string,
    open: boolean,
    optionLabel: (option: string) => string
) {
    const [found, setFound] = useState<readonly Ref[] | null>(null);
    const target = field.kind === "relation" ? field.target! : null;
    useEffect(() => {
        if (!target || !open) return;
        let current = true;
        const timer = window.setTimeout(() => {
            unwrap(() => actions.searchRefsAction({ object: target, search }), "")
                .then((answer) => current && setFound(answer.refs))
                .catch(() => current && setFound([]));
        }, LOOKUP_DELAY_MS);
        return () => {
            current = false;
            window.clearTimeout(timer);
        };
    }, [target, search, open]);
    return useMemo(() => {
        if (field.kind === "select") {
            return (field.options ?? []).map((option) => ({
                ...filters.optionChoice(option),
                name: optionLabel(option)
            }));
        }
        if (field.kind === "member")
            return people.filter((one) => menuSearchMatches(one.name, search));
        return found;
    }, [field, people, search, found, optionLabel]);
}

function ChoicePicker({
    object,
    field,
    chosen,
    people,
    onChange
}: {
    object: CrmObject;
    field: FieldDef;
    chosen: readonly Ref[];
    people: readonly Ref[];
    onChange: (choices: Ref[]) => void;
}) {
    const t = useCrmT();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const optionLabel = useCallback(
        (option: string) =>
            t(`options.${object}.${field.key}.${option}` as Parameters<typeof t>[0]),
        [t, object, field.key]
    );
    const choices = useChoices(field, people, search, open, optionLabel);
    const named = (choice: Ref) => (field.kind === "select" ? optionLabel(choice.id) : choice.name);
    const isChosen = (id: string) => chosen.some((one) => one.id === id);
    const toggle = (choice: Ref) =>
        onChange(
            isChosen(choice.id)
                ? chosen.filter((one) => one.id !== choice.id)
                : [
                      ...chosen,
                      { id: choice.id, name: field.kind === "select" ? "" : choice.name }
                  ].slice(0, filters.MAX_CHOICES)
        );
    const summary = chosen.map(named).join(", ");
    const searchable = field.kind !== "select";

    const line = (choice: Ref) => {
        if (field.kind === "select") {
            return <OptionChip field={field} option={choice.id} label={optionLabel(choice.id)} />;
        }
        if (field.kind === "member") return <MemberLine value={choice} />;
        return <RefChip target={field.target!} value={choice} />;
    };

    // The chosen ones first, so taking one out never needs a search.
    const listed = [
        ...chosen.filter((one) => !searchable || menuSearchMatches(named(one), search)),
        ...(choices ?? []).filter((one) => !isChosen(one.id))
    ];

    return (
        <DropdownMenu
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) setSearch("");
            }}
        >
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-full min-w-0 justify-between font-normal"
                    aria-label={t("filters.value")}
                >
                    <span
                        className={cn("truncate", !summary && "text-muted-foreground")}
                        title={summary || undefined}
                    >
                        {summary || t("filters.choose")}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
                {searchable ? (
                    <MenuSearch
                        value={search}
                        onChange={setSearch}
                        placeholder={t("picker.search")}
                    />
                ) : null}
                {listed.map((choice) => (
                    <DropdownMenuItem
                        key={choice.id}
                        className="gap-2"
                        onSelect={(event) => {
                            event.preventDefault();
                            toggle(choice);
                        }}
                    >
                        <span className="flex min-w-0 flex-1 items-center">{line(choice)}</span>
                        {isChosen(choice.id) ? <Check className="size-3.5 shrink-0" /> : null}
                    </DropdownMenuItem>
                ))}
                {choices === null ? (
                    <DropdownMenuItem disabled>{t("list.loading")}</DropdownMenuItem>
                ) : listed.length === 0 ? (
                    <DropdownMenuItem disabled>{t("picker.noMatches")}</DropdownMenuItem>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
