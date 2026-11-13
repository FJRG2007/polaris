"use client";

/**
 * Code's "/" list, on the same list and keys as Chat's: the person's skills
 * (a new task starts with the one picked) and their own commands, which are
 * spelled out when the message is sent.
 */

import { useId, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { SquareSlash, Wand2 } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
    SuggestionList,
    firstPickable,
    stepPickable,
    suggestionOptionId,
    type SuggestionListItem
} from "@/components/rich-text/suggestion-list";
import * as polarSlash from "@/lib/polar/slash";
import type { PolarCommandRow } from "@/lib/polar/shared";

export interface CodeSlashSkill {
    readonly name: string;
    readonly description: string;
}

export type CodeSlashMatch =
    | { kind: "skill"; skill: CodeSlashSkill }
    | { kind: "own"; row: PolarCommandRow };

/** The rows that match what has been typed: skills first, then the person's own. */
export function codeSlashMatches(
    input: string,
    skills: readonly CodeSlashSkill[],
    own: readonly PolarCommandRow[]
): CodeSlashMatch[] {
    const query = polarSlash.slashQuery(input);
    if (query === null) return [];
    return [
        ...polarSlash
            .rankedByShortcut(skills, (skill) => skill.name.toLowerCase(), query)
            .map((skill): CodeSlashMatch => ({ kind: "skill", skill })),
        ...polarSlash
            .rankedByShortcut(own, (row) => row.shortcut, query)
            .map((row): CodeSlashMatch => ({ kind: "own", row }))
    ];
}

/**
 * The list and the keys it answers for one Code composer. `onSkill` is null
 * where a skill cannot be applied (a session already running).
 */
export function useCodeSlash({
    value,
    onValueChange,
    skills,
    own,
    onSkill
}: {
    value: string;
    onValueChange: (value: string) => void;
    skills: readonly CodeSlashSkill[];
    own: readonly PolarCommandRow[];
    onSkill: ((name: string) => void) | null;
}) {
    const t = useTranslations("polar");
    const listId = useId();
    const [active, setActive] = useState(0);
    // Escape closes the list for the "/" token it was open on.
    const [dismissed, setDismissed] = useState<string | null>(null);
    const found = codeSlashMatches(value, onSkill ? skills : [], own);
    const items: SuggestionListItem[] = found.map((match) =>
        match.kind === "skill"
            ? {
                  key: `skill:${match.skill.name}`,
                  label: `/${match.skill.name}`,
                  detail: match.skill.description || undefined,
                  icon: Wand2,
                  group: t("slash.groups.skills")
              }
            : {
                  key: `own:${match.row.id}`,
                  label: `/${match.row.shortcut}`,
                  detail: match.row.prompt,
                  icon: SquareSlash,
                  group: t("slash.groups.own")
              }
    );
    const open = dismissed !== value && items.length > 0;
    const highlight =
        items[active] && !items[active].disabled ? active : firstPickable(items);

    const pick = (index: number) => {
        const match = found[index];
        if (!match) return;
        setActive(0);
        if (match.kind === "skill") {
            onSkill?.(match.skill.name);
            onValueChange("");
            return;
        }
        // The shortcut stays in the box; what is typed after it is added to
        // the command's words when the message is sent.
        onValueChange(`/${match.row.shortcut} `);
    };
    const complete = (index: number) => {
        const match = found[index];
        if (!match) return;
        if (match.kind === "skill") return pick(index);
        onValueChange(`/${match.row.shortcut} `);
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (!open || event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(stepPickable(items, highlight, event.key === "ArrowDown" ? 1 : -1));
        } else if (event.key === "Tab" && !event.shiftKey) {
            if (highlight < 0) return;
            event.preventDefault();
            complete(highlight);
        } else if (event.key === "Enter" && !event.shiftKey) {
            if (highlight < 0) return;
            event.preventDefault();
            pick(highlight);
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(value);
        }
    };

    const list = open ? (
        <SuggestionList
            id={listId}
            label={t("slash.title")}
            items={items}
            active={highlight}
            onHover={setActive}
            onPick={pick}
            className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-sm"
        />
    ) : null;

    return {
        list,
        textareaProps: {
            onKeyDown,
            "aria-controls": open ? listId : undefined,
            "aria-activedescendant":
                open && highlight >= 0 ? suggestionOptionId(listId, highlight) : undefined
        },
        /** What to send: the person's command spelled out, else the text. */
        expand: (text: string) => polarSlash.withOwnCommand(text, own)
    };
}
