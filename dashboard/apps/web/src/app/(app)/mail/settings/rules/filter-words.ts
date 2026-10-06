/**
 * A filter in words: what each kind of node is called, how a blank one starts,
 * and each node - and the whole filter - as a sentence.
 *
 * The list reads a filter back as one sentence ("If the subject contains 'PR run
 * failed:', put it in the trash"), the canvas puts one per node, and the editor
 * names its cards with the same words, so all three say the same thing.
 */

import * as core from "@polaris/core";
import type { NamespaceTranslator } from "@/lib/i18n/types";

export type Translator = NamespaceTranslator<"mailSettings">;

/** Every field a condition can look at, in the order the menus offer them. */
export const CONDITION_KINDS: readonly core.MailRuleField[] = [
    "from",
    "to",
    "cc",
    "recipient",
    "subject",
    "body",
    "list",
    "header",
    "attachment",
    "size"
];

/** Every step a filter can take, in the order the menus offer them. */
export const STEP_KINDS: readonly core.MailFilterStepKind[] = [
    "move",
    "archive",
    "trash",
    "junk",
    "read",
    "star",
    "label",
    "pin",
    "mute",
    "forward",
    "stop"
];

/** Names of the comparisons, under `rules.operators.<key>`. */
const OPERATOR_KEYS = {
    contains: "contains",
    "not-contains": "notContains",
    is: "is",
    "is-not": "isNot",
    "starts-with": "startsWith",
    "ends-with": "endsWith",
    matches: "matches",
    similar: "similar",
    "greater-than": "greaterThan",
    "less-than": "lessThan"
} as const satisfies Record<core.MailRuleOperator, string>;

export function operatorText(operator: core.MailRuleOperator, t: Translator): string {
    const key = OPERATOR_KEYS[operator];
    return key ? t(`rules.operators.${key}`) : operator;
}

export function conditionKindText(kind: core.MailRuleField, t: Translator): string {
    return CONDITION_KINDS.includes(kind) ? t(`rules.kinds.${kind}`) : kind;
}

export function stepKindText(kind: core.MailFilterStepKind, t: Translator): string {
    return STEP_KINDS.includes(kind) ? t(`rules.steps.${kind}`) : kind;
}

/** A condition of a kind, with the comparison that kind starts on and nothing
 *  to look for yet. */
export function blankCondition(kind: core.MailRuleField): core.MailFilterCondition {
    const id = core.automationNodeId();
    if (kind === "attachment") return { id, kind, operator: "is", value: "yes" };
    if (kind === "size") return { id, kind, operator: "greater-than", value: "1048576" };
    if (kind === "header") return { id, kind, operator: "contains", value: "", header: "" };
    return { id, kind, operator: "contains", value: "" };
}

/** A step of a kind. A folder, label or address to choose starts empty, so
 *  the step reads as unfinished until one is chosen. */
export function blankStep(kind: core.MailFilterStepKind): core.MailFilterStep {
    const id = core.automationNodeId();
    switch (kind) {
        case "move":
            return { id, kind, folder: "" };
        case "label":
            return { id, kind, label: "" };
        case "forward":
            return { id, kind, to: "" };
        default:
            return { id, kind } as core.MailFilterStep;
    }
}

/** A brand-new filter: on arrival, one empty condition on the sender, and a
 *  move to choose - or what "Filter messages like this" filled in. */
export function blankDefinition(seed?: {
    from: string;
    similar: string;
}): core.MailFilterDefinition {
    const items: core.MailFilterCondition[] = [
        ...(seed?.from
            ? [{ ...blankCondition("from"), operator: "is" as const, value: seed.from }]
            : []),
        ...(seed?.similar
            ? [{ ...blankCondition("subject"), operator: "similar" as const, value: seed.similar }]
            : [])
    ];
    return {
        triggers: [{ id: core.automationNodeId(), kind: "arrival" }],
        conditions: {
            match: "all",
            groups: [
                {
                    id: core.automationNodeId(),
                    match: "all",
                    items: items.length > 0 ? items : [blankCondition("from")]
                }
            ]
        },
        actions: [blankStep("archive")]
    };
}

/** What a filter's sentences need to name a folder or a label. */
export interface FilterLookup {
    readonly folderName: (id: string) => string | undefined;
    readonly labelName: (id: string) => string | undefined;
}

/** One condition as a phrase: "the subject contains 'PR run failed:'". */
export function describeCondition(condition: core.MailFilterCondition, t: Translator): string {
    if (condition.kind === "attachment") {
        return condition.value === "no"
            ? t("rules.said.noAttachments")
            : t("rules.said.hasAttachments");
    }
    if (condition.kind === "size") {
        const size = core.formatBytes(Number(condition.value) || 0);
        return condition.operator === "less-than"
            ? t("rules.said.smallerThan", { size })
            : t("rules.said.largerThan", { size });
    }
    const field =
        condition.kind === "header"
            ? t("rules.said.header", { header: condition.header || "?" })
            : t(`rules.fields.${condition.kind}`);
    const negative = condition.operator === "not-contains" || condition.operator === "is-not";
    // "this" or "that": the template quotes the first and the last, the joins
    // quote the ones between.
    const join = `" ${negative ? t("rules.editor.nor") : t("rules.editor.or")} "`;
    const said = t("rules.condition", {
        field,
        operator: operatorText(condition.operator, t),
        value: [condition.value, ...(condition.alternatives ?? [])].join(join)
    });
    return condition.caseSensitive ? `${said}${t("rules.said.caseSensitive")}` : said;
}

/** One step as a phrase: "move it to Accounts". */
export function describeStep(
    step: core.MailFilterStep,
    lookup: FilterLookup,
    t: Translator
): string {
    switch (step.kind) {
        case "move": {
            const folder = lookup.folderName(step.folder);
            return folder ? t("rules.said.move", { folder }) : t("rules.said.moveSomewhere");
        }
        case "label": {
            const label = lookup.labelName(step.label);
            return label ? t("rules.said.label", { label }) : t("rules.said.labelSomething");
        }
        case "forward":
            return step.to ? t("rules.said.forward", { to: step.to }) : t("rules.actions.forward");
        case "stop":
            return t("rules.said.stop");
        default:
            return t(`rules.actions.${step.kind}`);
    }
}

/** A group of conditions as a phrase, joined the way the group joins them. */
function describeGroup(group: core.MailFilterGroup, t: Translator): string {
    const joiner = group.match === "all" ? t("rules.and") : t("rules.or");
    return group.items.map((item) => describeCondition(item, t)).join(joiner);
}

/** A whole filter as the sentence the list reads it back as. */
export function describeFilter(
    definition: core.MailFilterDefinition,
    lookup: FilterLookup,
    t: Translator
): string {
    const { groups, match } = definition.conditions;
    const conditions =
        groups.length === 1
            ? describeGroup(groups[0]!, t)
            : groups
                  .map((group) => t("rules.said.group", { conditions: describeGroup(group, t) }))
                  .join(match === "all" ? t("rules.and") : t("rules.or"));
    const actions = definition.actions
        .filter((step) => step.kind !== "stop")
        .map((step) => describeStep(step, lookup, t))
        .join(", ");
    return t("rules.sentence", { conditions, actions });
}
