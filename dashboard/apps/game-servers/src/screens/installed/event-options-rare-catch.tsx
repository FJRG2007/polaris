"use client";

/** A rare catch's settings: which treasure the race is for. */

import { Select } from "@polaris/ui";
import { Field, options } from "./event-editor";
import { useGameText } from "../game-text";
import type { GameKey } from "../../../messages";
import type * as catalog from "../../lib/minecraft/events/catalog";

type Value = catalog.EventOptions<"rare-catch">;

export const CATCH_LABELS: Readonly<Record<Value["treasure"], GameKey<"minecraft">>> = {
    any: "events.catches.any",
    name_tag: "events.catches.name_tag",
    saddle: "events.catches.saddle",
    nautilus_shell: "events.catches.nautilus_shell",
    enchanted_book: "events.catches.enchanted_book",
    bow: "events.catches.bow"
};

export function RareCatchOptions({
    value,
    onChange
}: {
    value: Value;
    onChange: (next: Value) => void;
}) {
    const t = useGameText("minecraft");
    return (
        <Field label={t("editor.theCatch")} hint={t("editor.catchHint")}>
            <Select
                value={value.treasure}
                onValueChange={(treasure) =>
                    onChange({ ...value, treasure: treasure as Value["treasure"] })
                }
                options={options(t, CATCH_LABELS)}
                aria-label={t("editor.theCatch")}
            />
        </Field>
    );
}
