"use client";

/** A rare catch's settings: which treasure the race is for. */

import { Select } from "@polaris/ui";
import { Field, options } from "./event-editor";
import type * as catalog from "../../lib/minecraft/events/catalog";

type Value = catalog.EventOptions<"rare-catch">;

export const CATCH_LABELS: Readonly<Record<Value["treasure"], string>> = {
    any: "Any fishing treasure",
    name_tag: "Name tag",
    saddle: "Saddle",
    nautilus_shell: "Nautilus shell",
    enchanted_book: "Enchanted book",
    bow: "Bow"
};

export function RareCatchOptions({
    value,
    onChange
}: {
    value: Value;
    onChange: (next: Value) => void;
}) {
    return (
        <Field
            label="The catch"
            hint="One treasure comes up about once in 120 catches, any of them about once in 25 - in open water, more often with Luck of the Sea. Give it 20 minutes or more."
        >
            <Select
                value={value.treasure}
                onValueChange={(treasure) =>
                    onChange({ ...value, treasure: treasure as Value["treasure"] })
                }
                options={options(CATCH_LABELS)}
                aria-label="The catch"
            />
        </Field>
    );
}
