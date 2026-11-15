"use client";

/**
 * Code's "/" list, on the same list and keys as Chat's: Code's own commands
 * (`lib/polar/code-commands`), the person's skills (a new task starts with the
 * one picked), their own commands, which are spelled out when the message
 * is sent, and Enigma's, handed to the session's agent as typed.
 */

import { useId, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    CircleHelp,
    ClipboardCopy,
    Cpu,
    Download,
    Gauge,
    Eraser,
    FileDiff,
    FilePlus2,
    History,
    ListTodo,
    LogOut,
    Brain,
    Minimize2,
    Pencil,
    Plus,
    ScanSearch,
    Scissors,
    ShieldCheck,
    Sparkles,
    Square,
    SquareSlash,
    Target,
    Wand2
} from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
    firstPickable,
    stepPickable,
    suggestionOptionId,
    type SuggestionListItem
} from "@/components/rich-text/suggestion-list";
import * as polarSlash from "@/lib/polar/slash";
import * as codeCommands from "@/lib/polar/code-commands";
import * as enigmaSlash from "@/lib/polar/enigma-slash";
import type { PolarCommandRow } from "@/lib/polar/shared";
import { PolarSlashMenu } from "@/components/polar/polar-slash-menu";

type CodeCommand = codeCommands.CodeCommand;

const COMMAND_ICONS: Record<CodeCommand, SuggestionListItem["icon"]> = {
    help: CircleHelp,
    new: Plus,
    resume: History,
    model: Cpu,
    clear: Eraser,
    compact: Minimize2,
    review: ScanSearch,
    "security-review": ShieldCheck,
    init: FilePlus2,
    stop: Square,
    rename: Pencil,
    diff: FileDiff,
    context: Gauge,
    export: Download,
    memory: Brain,
    goal: Target,
    plan: ListTodo,
    simplify: Scissors,
    copy: ClipboardCopy,
    exit: LogOut
};

type CommandLine = Exclude<CodeCommand, "security-review"> | "securityReview" | "clearDraft";

/** The catalog key of a command's line, under `polar.slash.code`. */
function commandKey(command: CodeCommand, place: codeCommands.CodeCommandPlace): CommandLine {
    if (command === "clear" && place === "start") return "clearDraft";
    return command === "security-review" ? "securityReview" : command;
}

export interface CodeSlashSkill {
    readonly name: string;
    readonly description: string;
}

export type CodeSlashMatch =
    | { kind: "command"; command: CodeCommand }
    | { kind: "skill"; skill: CodeSlashSkill }
    | { kind: "own"; row: PolarCommandRow }
    | { kind: "enigma"; command: enigmaSlash.EnigmaSlashCommand };

/** The rows that match what has been typed: Code's commands, the skills, the
 *  person's own, then Enigma's. One of theirs that shares a command's name is
 *  hidden by it, as in Chat, and Enigma's steps aside for any name above it. */
export function codeSlashMatches(
    input: string,
    skills: readonly CodeSlashSkill[],
    own: readonly PolarCommandRow[],
    commands: readonly CodeCommand[] = [],
    enigma: readonly enigmaSlash.EnigmaSlashCommand[] = []
): CodeSlashMatch[] {
    const query = polarSlash.slashQuery(input);
    if (query === null) return [];
    const taken = new Set<string>(commands);
    return [
        ...codeCommands
            .matchCodeCommands(input, commands)
            .map((command): CodeSlashMatch => ({ kind: "command", command })),
        ...polarSlash
            .rankedByShortcut(skills, (skill) => skill.name.toLowerCase(), query)
            .map((skill): CodeSlashMatch => ({ kind: "skill", skill })),
        ...polarSlash
            .rankedByShortcut(
                own.filter((row) => !taken.has(row.shortcut)),
                (row) => row.shortcut,
                query
            )
            .map((row): CodeSlashMatch => ({ kind: "own", row })),
        ...enigmaSlash
            .matchEnigmaCommands(
                input,
                enigma,
                new Set([...taken, ...skills.map((skill) => skill.name), ...own.map((row) => row.shortcut)])
            )
            .map((command): CodeSlashMatch => ({ kind: "enigma", command }))
    ];
}

/**
 * The list and the keys it answers for one Code composer. `onSkill` is null
 * where a skill cannot be applied (a session already running). `commands` are
 * Code's own on offer here, and `onCommand` runs one, picked or typed whole.
 * `enigma` are Enigma's commands, sent to the session's agent as typed.
 */
export function useCodeSlash({
    value,
    onValueChange,
    skills,
    own,
    onSkill,
    place = "thread",
    commands = [],
    enigma = [],
    onCommand
}: {
    value: string;
    onValueChange: (value: string) => void;
    skills: readonly CodeSlashSkill[];
    own: readonly PolarCommandRow[];
    onSkill: ((name: string) => void) | null;
    place?: codeCommands.CodeCommandPlace;
    commands?: readonly CodeCommand[];
    enigma?: readonly enigmaSlash.EnigmaSlashCommand[];
    onCommand?: (command: CodeCommand, rest: string) => void;
}) {
    const t = useTranslations("polar");
    const listId = useId();
    const [active, setActive] = useState(0);
    // Escape closes the list for the "/" token it was open on.
    const [dismissed, setDismissed] = useState<string | null>(null);
    const found = codeSlashMatches(value, onSkill ? skills : [], own, commands, enigma);
    const items: SuggestionListItem[] = found.map((match) =>
        match.kind === "command"
            ? {
                  key: `command:${match.command}`,
                  label: `/${match.command}`,
                  detail: t(`slash.code.${commandKey(match.command, place)}`),
                  icon: COMMAND_ICONS[match.command],
                  group: t("slash.groups.code")
              }
            : match.kind === "skill"
              ? {
                    key: `skill:${match.skill.name}`,
                    label: `/${match.skill.name}`,
                    detail: match.skill.description || undefined,
                    icon: Wand2,
                    group: t("slash.groups.skills")
                }
              : match.kind === "enigma"
                ? {
                      key: `enigma:${match.command.name}`,
                      label: `/${match.command.name}`,
                      detail: match.command.description,
                      icon: Sparkles,
                      group: t("slash.groups.enigma")
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
        if (match.kind === "command") {
            // One that takes words waits for them; the rest run at once.
            if (codeCommands.takesText(match.command)) return onValueChange(`/${match.command} `);
            onValueChange("");
            return onCommand?.(match.command, "");
        }
        if (match.kind === "skill") {
            onSkill?.(match.skill.name);
            onValueChange("");
            return;
        }
        // Enigma's command is sent as typed, with whatever follows its name.
        if (match.kind === "enigma") return onValueChange(`/${match.command.name} `);
        // The shortcut stays in the box; what is typed after it is added to
        // the command's words when the message is sent.
        onValueChange(`/${match.row.shortcut} `);
    };
    const complete = (index: number) => {
        const match = found[index];
        if (!match) return;
        if (match.kind === "skill") return pick(index);
        setActive(0);
        onValueChange(
            `/${match.kind === "command" ? match.command : match.kind === "enigma" ? match.command.name : match.row.shortcut} `
        );
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

    const list = (
        <PolarSlashMenu
            open={open}
            id={listId}
            label={t("slash.title")}
            items={items}
            active={highlight}
            onHover={setActive}
            onPick={pick}
            onDismiss={() => setDismissed(value)}
        />
    );

    return {
        list,
        textareaProps: {
            onKeyDown,
            "aria-controls": open ? listId : undefined,
            "aria-activedescendant":
                open && highlight >= 0 ? suggestionOptionId(listId, highlight) : undefined
        },
        /** Runs the Code command the text is, typed whole; true when it was
         *  one, and then nothing is left to send as typed. */
        run: (text: string): boolean => {
            const typed = codeCommands.codeCommandIn(text, commands);
            if (!typed || !onCommand) return false;
            onCommand(typed.command, typed.rest);
            return true;
        },
        /** What to send: the person's command spelled out, else the text. */
        expand: (text: string) => polarSlash.withOwnCommand(text, own)
    };
}
