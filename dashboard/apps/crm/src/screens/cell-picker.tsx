"use client";

/**
 * Choosing a field's value from a list rather than typing it: a stage, an
 * owner, or the company or person a record points at. The menu opens on the
 * cell, narrows as a name is typed, and offers "none" first for a field that
 * may be left empty.
 *
 * Records are found on the server by name as the reader types (the list of
 * companies can be any length); the owners are the shelf's members, already in
 * hand.
 */

import { unwrap } from "./call";
import { optionLabel } from "./custom-fields";
import { useCrmT } from "./i18n";
import { MAX_LINKED } from "../model/values";
import { Check, X } from "lucide-react";
import * as actions from "../actions/records";
import { MemberLine, OptionChip, RefChip } from "./cell-display";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
    isLinkList,
    linksOf,
    type CrmObject,
    type FieldDef,
    type FieldValue,
    type Ref
} from "../model/objects";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    MenuSearch,
    menuSearchMatches
} from "@polaris/ui";

/** How long typing has to pause before a name is looked up. */
const LOOKUP_DELAY_MS = 200;

export interface PickerProps {
    readonly object: CrmObject;
    readonly field: FieldDef;
    readonly value: FieldValue | undefined;
    /** Who may own a record on this shelf. */
    readonly people: readonly Ref[];
    /** The id or option to store - for a relation somebody added, the list of
     *  ids - and what the cell shows until the answer. */
    readonly onPick: (stored: string | readonly string[] | null, shown: FieldValue) => void;
    readonly onClose: () => void;
}

/** The records of one kind whose names match what is typed, looked up as the
 *  typing pauses. A late answer for an older search is thrown away. */
function useRefLookup(target: CrmObject, search: string) {
    const [found, setFound] = useState<readonly Ref[] | null>(null);
    useEffect(() => {
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
    }, [target, search]);
    return found;
}

function Item({
    chosen,
    onSelect,
    children
}: {
    chosen: boolean;
    onSelect: () => void;
    children: ReactNode;
}) {
    return (
        <DropdownMenuItem onSelect={onSelect} className="gap-2">
            <span className="flex min-w-0 flex-1 items-center">{children}</span>
            {chosen ? <Check className="size-3.5 shrink-0 text-foreground" /> : null}
        </DropdownMenuItem>
    );
}

function RelationOptions({
    target,
    search,
    selectedId,
    onPick
}: {
    target: CrmObject;
    search: string;
    selectedId: string | null;
    onPick: (ref: Ref) => void;
}) {
    const t = useCrmT();
    const found = useRefLookup(target, search);
    if (found === null) {
        return (
            <p className="px-2 py-1.5 text-[0.8125rem] text-muted-foreground">
                {t("list.loading")}
            </p>
        );
    }
    if (found.length === 0) {
        return (
            <p className="px-2 py-1.5 text-[0.8125rem] text-muted-foreground">
                {t("picker.noMatches")}
            </p>
        );
    }
    return (
        <>
            {found.map((ref) => (
                <Item key={ref.id} chosen={ref.id === selectedId} onSelect={() => onPick(ref)}>
                    <RefChip target={target} value={ref} />
                </Item>
            ))}
        </>
    );
}

/**
 * The menu, anchored to the cell it is drawn in. Mounted open; closing it, by
 * a choice or by pressing elsewhere, is the caller's cue to drop it.
 */
export function CellPicker(props: PickerProps) {
    return isLinkList(props.field) ? <LinkListPicker {...props} /> : <OnePicker {...props} />;
}

/**
 * The records a relation somebody added holds, picked from a list: the ones it
 * holds first, then the ones whose names match. A field that holds one swaps
 * it and closes; a field that holds many toggles each and saves once, as the
 * menu closes.
 */
function LinkListPicker({ field, value, onPick: pick, onClose }: PickerProps) {
    const t = useCrmT();
    const target = field.target!;
    const [search, setSearch] = useState("");
    const start = linksOf(value);
    const [draft, setDraft] = useState<readonly Ref[]>(start);
    const found = useRefLookup(target, search);
    const chosen = new Set(draft.map((ref) => ref.id));
    // A list that holds as many as it may takes no more until one is let go.
    const full = field.many === true && draft.length >= MAX_LINKED;
    const same = (next: readonly Ref[]) =>
        next.length === start.length && next.every((ref, at) => ref.id === start[at]!.id);
    const commit = (next: readonly Ref[]) =>
        same(next)
            ? onClose()
            : pick(
                  next.map((ref) => ref.id),
                  next
              );
    const toggle = (ref: Ref) => {
        if (!field.many) return commit(chosen.has(ref.id) ? [] : [ref]);
        setDraft(chosen.has(ref.id) ? draft.filter((one) => one.id !== ref.id) : [...draft, ref]);
    };
    const shown = draft.filter((ref) => menuSearchMatches(ref.name, search));
    const others = (found ?? []).filter((ref) => !chosen.has(ref.id));

    return (
        <DropdownMenu open onOpenChange={(open) => !open && commit(draft)}>
            <DropdownMenuTrigger asChild>
                <span aria-hidden className="pointer-events-none absolute inset-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={2} className="w-64">
                <MenuSearch value={search} onChange={setSearch} placeholder={t("picker.search")} />
                <div className="max-h-72 overflow-y-auto pt-1">
                    {[...shown, ...others].map((ref) => (
                        <DropdownMenuItem
                            key={ref.id}
                            className="gap-2"
                            disabled={full && !chosen.has(ref.id)}
                            onSelect={(event) => {
                                if (field.many) event.preventDefault();
                                toggle(ref);
                            }}
                        >
                            <span className="flex min-w-0 flex-1 items-center">
                                <RefChip target={target} value={ref} />
                            </span>
                            {chosen.has(ref.id) ? (
                                <Check className="size-3.5 shrink-0 text-foreground" />
                            ) : null}
                        </DropdownMenuItem>
                    ))}
                    {found === null && others.length === 0 ? (
                        <p className="px-2 py-1.5 text-[0.8125rem] text-muted-foreground">
                            {t("list.loading")}
                        </p>
                    ) : null}
                    {found !== null && shown.length === 0 && others.length === 0 ? (
                        <p className="px-2 py-1.5 text-[0.8125rem] text-muted-foreground">
                            {t("picker.noMatches")}
                        </p>
                    ) : null}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function OnePicker({ object, field, value, people, onPick: pick, onClose }: PickerProps) {
    const t = useCrmT();
    const [search, setSearch] = useState("");
    const selected =
        typeof value === "string"
            ? value
            : value && "id" in (value as Ref)
              ? (value as Ref).id
              : null;
    const members = useMemo(
        () => people.filter((person) => menuSearchMatches(person.name, search)),
        [people, search]
    );
    const options = (field.options ?? []).filter((option) =>
        menuSearchMatches(optionLabel(t, object, field, option), search)
    );
    const clearable = field.kind !== "select" && selected !== null;
    // Picking what the cell already holds closes the menu without a write.
    const onPick = (stored: string | null, shown: FieldValue) =>
        stored === selected ? onClose() : pick(stored, shown);

    return (
        <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
            <DropdownMenuTrigger asChild>
                <span aria-hidden className="pointer-events-none absolute inset-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={2} className="w-64">
                <MenuSearch value={search} onChange={setSearch} placeholder={t("picker.search")} />
                <div className="pt-1">
                    {clearable ? (
                        <>
                            <DropdownMenuItem onSelect={() => onPick(null, null)} className="gap-2">
                                <X className="size-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground">{t("picker.none")}</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                        </>
                    ) : null}
                    {field.kind === "select"
                        ? options.map((option) => (
                              <Item
                                  key={option}
                                  chosen={option === selected}
                                  onSelect={() => onPick(option, option)}
                              >
                                  <OptionChip
                                      field={field}
                                      option={option}
                                      label={optionLabel(t, object, field, option)}
                                  />
                              </Item>
                          ))
                        : null}
                    {field.kind === "member"
                        ? members.map((person) => (
                              <Item
                                  key={person.id}
                                  chosen={person.id === selected}
                                  onSelect={() => onPick(person.id, person)}
                              >
                                  <MemberLine value={person} />
                              </Item>
                          ))
                        : null}
                    {field.kind === "relation" && field.target ? (
                        <RelationOptions
                            target={field.target}
                            search={search}
                            selectedId={selected}
                            onPick={(ref) => onPick(ref.id, ref)}
                        />
                    ) : null}
                    {(field.kind === "select" && options.length === 0) ||
                    (field.kind === "member" && members.length === 0) ? (
                        <p className="px-2 py-1.5 text-[0.8125rem] text-muted-foreground">
                            {t("picker.noMatches")}
                        </p>
                    ) : null}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
