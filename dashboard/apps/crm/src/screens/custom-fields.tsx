/**
 * The fields added to the list's kind of record, for every part of the screen
 * that names, draws or edits a field.
 *
 *     const custom = useCustomFields();
 *     const field = fieldOf(object, key, custom);
 */

import { createContext, useContext } from "react";
import type { CrmTranslator } from "../lib/i18n";
import type { CrmObject, FieldDef } from "../model/objects";

const CustomFieldsContext = createContext<readonly FieldDef[]>([]);

export const CustomFieldsProvider = CustomFieldsContext.Provider;

export function useCustomFields(): readonly FieldDef[] {
    return useContext(CustomFieldsContext);
}

/** What a field is called: its own name when somebody added it. */
export function fieldLabel(t: CrmTranslator, object: CrmObject, field: FieldDef): string {
    return field.label ?? t(`fields.${object}.${field.key}` as Parameters<typeof t>[0]);
}

/** What one choice of a select is called: as typed when somebody added it, and
 *  "No value" for an unset one. */
export function optionLabel(
    t: CrmTranslator,
    object: CrmObject,
    field: FieldDef,
    option: string
): string {
    if (!field.custom) {
        return t(`options.${object}.${field.key}.${option}` as Parameters<typeof t>[0]);
    }
    return option === "" ? t("customFields.noValue") : option;
}
