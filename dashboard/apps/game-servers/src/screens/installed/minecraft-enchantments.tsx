"use client";

/**
 * Choosing enchantments: the list a stack is given, one row per enchantment
 * with its level, and the picker that adds the next.
 *
 * Used twice - on a stack a player already holds, as a dialog, and beside the
 * palette for what is about to be given - so both offer the same enchantments
 * for an item and refuse the same sets. What is offered is what fits the item on
 * this server's version; an enchantment a mod added is shown by its id and can
 * still be levelled and taken off.
 *
 * Every change is checked against the schema the action checks it with.
 */

import { useMemo, useState } from "react";
import { Trash2, X } from "lucide-react";
import { useGameText, useSchemaText } from "../game-text";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SearchableSelect,
    Switch
} from "@polaris/ui";
import { itemLabel } from "../../lib/minecraft/items";
import type { InventoryItem } from "../../lib/minecraft/inventory";
import { enchantmentLabel, levelText, type Enchantment } from "../../lib/minecraft/item-details";
import {
    MAX_ENCHANT_LEVEL,
    editableEnchantments,
    enchantmentInfo,
    enchantmentSetSchema,
    exceedsMax,
    offeredEnchantments,
    sameEnchantment,
    type EnchantmentSet
} from "../../lib/minecraft/enchantments";

/** A set as the dialog holds it while it is being edited. */
export interface EnchantDraft {
    readonly enchantments: readonly Enchantment[];
    readonly overMax: boolean;
}

/** An empty draft, which gives the plain item. */
export const NO_ENCHANTMENTS: EnchantDraft = { enchantments: [], overMax: false };

/** The draft as the action takes it, or the first reason it would be refused. */
export function checkDraft(
    draft: EnchantDraft
): { ok: true; value: EnchantmentSet } | { ok: false; message: string | undefined } {
    const parsed = enchantmentSetSchema.safeParse({
        enchantments: [...draft.enchantments],
        overMax: draft.overMax
    });
    return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message };
}

/** Whether two sets are the same, regardless of order. */
export function sameSet(left: readonly Enchantment[], right: readonly Enchantment[]): boolean {
    return (
        left.length === right.length &&
        left.every((one) =>
            right.some((other) => sameEnchantment(one.id, other.id) && other.level === one.level)
        )
    );
}

/** The highest level a row may be set to. */
function ceilingOf(id: string, overMax: boolean): number {
    const info = enchantmentInfo(id);
    return overMax || !info ? MAX_ENCHANT_LEVEL : info.max;
}

export function EnchantmentFields({
    itemId,
    draft,
    onChange,
    available,
    disabled
}: {
    itemId: string;
    draft: EnchantDraft;
    onChange: (draft: EnchantDraft) => void;
    /** The vanilla enchantments this server has; null when it could not say. */
    available: readonly string[] | null;
    disabled?: boolean;
}) {
    const t = useGameText("minecraft");
    const schemaText = useSchemaText();
    const [every, setEvery] = useState(false);
    const [adding, setAdding] = useState("");
    const offered = useMemo(
        () => offeredEnchantments(itemId, draft.enchantments, available, every),
        [itemId, draft.enchantments, available, every]
    );
    const checked = checkDraft(draft);
    const problem = checked.ok ? null : (schemaText(checked.message) ?? null);

    const set = (enchantments: readonly Enchantment[]) => onChange({ ...draft, enchantments });

    function add(id: string): void {
        const info = enchantmentInfo(id);
        if (!info) return;
        set([...draft.enchantments, { id: info.id, level: info.max }]);
        setAdding("");
    }

    return (
        <div className="flex min-w-0 flex-col gap-2">
            {draft.enchantments.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("enchant.none")}</p>
            ) : (
                <ul className="flex flex-col gap-1.5" aria-label={t("enchant.listLabel")}>
                    {draft.enchantments.map((one, index) => {
                        const known = enchantmentInfo(one.id) !== null;
                        const name = enchantmentLabel(one.id);
                        const ceiling = ceilingOf(one.id, draft.overMax);
                        return (
                            <li key={one.id} className="flex min-w-0 items-center gap-2">
                                <div className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate text-sm" title={name}>
                                        {name}
                                    </span>
                                    {!known && (
                                        <span
                                            className="truncate font-mono text-[0.6875rem] text-muted-foreground"
                                            title={one.id}
                                        >
                                            {one.id}
                                        </span>
                                    )}
                                </div>
                                <Input
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    max={ceiling}
                                    value={one.level}
                                    disabled={disabled}
                                    aria-label={t("enchant.levelOf", { name })}
                                    aria-invalid={one.level > ceiling || one.level < 1}
                                    className="w-20 shrink-0"
                                    onChange={(event) => {
                                        const level = Math.trunc(Number(event.target.value));
                                        set(
                                            draft.enchantments.map((each, at) =>
                                                at === index
                                                    ? {
                                                          ...each,
                                                          level: Number.isFinite(level) ? level : 0
                                                      }
                                                    : each
                                            )
                                        );
                                    }}
                                />
                                <span className="w-8 shrink-0 text-xs text-muted-foreground tabular-nums">
                                    {one.level >= 1 ? levelText(one.level) : ""}
                                </span>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    disabled={disabled}
                                    aria-label={t("enchant.remove", { name })}
                                    title={t("enchant.remove", { name })}
                                    className="shrink-0 text-muted-foreground hover:text-danger"
                                    onClick={() =>
                                        set(draft.enchantments.filter((_each, at) => at !== index))
                                    }
                                >
                                    <X className="size-4" />
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            )}

            <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                    <SearchableSelect
                        aria-label={t("enchant.add")}
                        value={adding}
                        onValueChange={add}
                        disabled={disabled || offered.length === 0}
                        options={offered.map((info) => ({
                            value: info.id,
                            label: `${enchantmentLabel(info.id)} (${levelText(info.max)})`,
                            keywords: info.id
                        }))}
                        placeholder={
                            offered.length === 0 ? t("enchant.nothingFits") : t("enchant.add")
                        }
                        searchPlaceholder={t("enchant.search")}
                        emptyText={t("enchant.noMatch")}
                        className="w-full"
                    />
                </div>
                {draft.enchantments.length > 0 && (
                    <Button
                        size="icon"
                        variant="ghost"
                        disabled={disabled}
                        aria-label={t("enchant.removeAll")}
                        title={t("enchant.removeAll")}
                        className="shrink-0 text-muted-foreground hover:text-danger"
                        onClick={() => set([])}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                )}
            </div>

            <label className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0">
                    <span className="block">{t("enchant.overMax")}</span>
                    <span className="block text-muted-foreground">{t("enchant.overMaxHint")}</span>
                </span>
                <Switch
                    checked={draft.overMax}
                    disabled={disabled}
                    aria-label={t("enchant.overMax")}
                    onChange={(overMax) => onChange({ ...draft, overMax })}
                />
            </label>
            <label className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0">
                    <span className="block">{t("enchant.every")}</span>
                    <span className="block text-muted-foreground">{t("enchant.everyHint")}</span>
                </span>
                <Switch
                    checked={every}
                    disabled={disabled}
                    aria-label={t("enchant.every")}
                    onChange={setEvery}
                />
            </label>

            {problem && (
                <p role="alert" className="text-xs text-danger">
                    {problem}
                </p>
            )}
        </div>
    );
}

/**
 * The enchantments on a stack a player holds, edited in a dialog. Saving hands
 * the whole new set back; the caller writes it and owns the rollback.
 */
export function EnchantStackDialog({
    item,
    where,
    available,
    onClose,
    onSave
}: {
    item: InventoryItem;
    where: string;
    available: readonly string[] | null;
    onClose: () => void;
    onSave: (set: EnchantmentSet) => void;
}) {
    const t = useGameText("minecraft");
    const before = editableEnchantments(item);
    const [draft, setDraft] = useState<EnchantDraft>({
        enchantments: before,
        // A stack already past a maximum was made with a command, and opening
        // it must not make its own levels read as an error.
        overMax: exceedsMax(before)
    });
    const checked = checkDraft(draft);
    const changed = !sameSet(before, draft.enchantments);
    const name = itemLabel(item.id);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("enchant.title", { name })}</DialogTitle>
                    <DialogDescription>{t("enchant.description", { where })}</DialogDescription>
                </DialogHeader>
                <EnchantmentFields
                    itemId={item.id}
                    draft={draft}
                    onChange={setDraft}
                    available={available}
                />
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("enchant.cancel")}
                    </Button>
                    <Button
                        disabled={!checked.ok || !changed}
                        aria-disabled={!checked.ok || !changed}
                        onClick={() => checked.ok && onSave(checked.value)}
                    >
                        {t("enchant.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
