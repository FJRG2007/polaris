/**
 * The options chosen for one line, checked against the product's groups: each
 * group takes between its `min` and `max` options, an option belongs to one
 * group of this product, and none is picked twice. The price of every option
 * comes from the product, never from the device.
 *
 * Pure: the order screen uses it to enable Add, the server to refuse a line.
 */

export interface ModifierOption {
    readonly id: string;
    readonly name: string;
    readonly price: number;
}

export interface ModifierChoiceGroup {
    readonly id: string;
    readonly min: number;
    readonly max: number;
    readonly options: readonly ModifierOption[];
}

export type ModifierChoice =
    | { readonly ok: true; readonly modifiers: Array<{ name: string; price: number }> }
    | { readonly ok: false; readonly groupId: string | null };

export function chooseModifiers(groups: readonly ModifierChoiceGroup[], ids: readonly string[]): ModifierChoice {
    const owner = new Map<string, { group: ModifierChoiceGroup; option: ModifierOption }>();
    for (const group of groups) for (const option of group.options) owner.set(option.id, { group, option });
    if (new Set(ids).size !== ids.length) return { ok: false, groupId: null };
    const picked = new Map<string, number>();
    const modifiers: Array<{ name: string; price: number }> = [];
    for (const id of ids) {
        const found = owner.get(id);
        if (!found) return { ok: false, groupId: null };
        picked.set(found.group.id, (picked.get(found.group.id) ?? 0) + 1);
        modifiers.push({ name: found.option.name, price: found.option.price });
    }
    for (const group of groups) {
        const count = picked.get(group.id) ?? 0;
        if (count < group.min || count > group.max) return { ok: false, groupId: group.id };
    }
    return { ok: true, modifiers };
}

/** Toggles an option on the picker: a group with `max` 1 swaps, a full group ignores the tap. */
export function toggleModifier(groups: readonly ModifierChoiceGroup[], ids: readonly string[], optionId: string): string[] {
    if (ids.includes(optionId)) return ids.filter((id) => id !== optionId);
    const group = groups.find((g) => g.options.some((o) => o.id === optionId));
    if (!group) return [...ids];
    const inGroup = ids.filter((id) => group.options.some((o) => o.id === id));
    if (group.max === 1) return [...ids.filter((id) => !inGroup.includes(id)), optionId];
    if (inGroup.length >= group.max) return [...ids];
    return [...ids, optionId];
}
