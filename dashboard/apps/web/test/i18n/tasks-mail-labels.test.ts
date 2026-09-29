/**
 * The option labels Tasks and Mail read from `@polaris/core` (priorities, view
 * kinds, folder roles...) are drawn from the catalogs, keyed by the value. The
 * English has to be core's own, word for word, and every value core can hold
 * needs a label - a new priority or folder role added there fails here rather
 * than drawing its key.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { webCatalogs } from "../../messages";

/** An automation trigger is `task.created`; its key drops the `task.` a key path would split on. */
const keyOf = (value: string) => value.replace(/^task\./, "");

const TASKS: Record<string, Readonly<Record<string, string>>> = {
    priority: core.TASK_PRIORITY_LABELS,
    statusType: core.TASK_STATUS_TYPE_LABELS,
    statusTypeHint: core.TASK_STATUS_TYPE_HINTS,
    customField: core.CUSTOM_FIELD_LABELS,
    view: core.TASK_VIEW_LABELS,
    group: core.TASK_GROUP_LABELS,
    sort: core.TASK_SORT_LABELS,
    filter: core.TASK_FILTER_LABELS,
    filterOperator: core.TASK_FILTER_OPERATOR_LABELS,
    relativeDate: core.RELATIVE_DATE_LABELS,
    recurrence: core.RECURRENCE_MODE_LABELS,
    automationTrigger: core.AUTOMATION_TRIGGER_LABELS,
    automationAction: core.AUTOMATION_ACTION_LABELS,
    formField: core.FORM_FIELD_LABELS,
    goalTarget: core.GOAL_TARGET_LABELS,
    spaceRole: core.SPACE_ROLE_LABELS,
    spaceRoleHint: core.SPACE_ROLE_HINTS,
    dueBucket: core.DUE_BUCKET_LABELS
};

const MAIL: Record<string, Readonly<Record<string, string>>> = {
    signatureAuto: core.MAIL_SIGNATURE_AUTO_LABELS,
    category: core.MAIL_CATEGORY_LABELS,
    filter: core.MAIL_FILTER_LABELS,
    sort: core.MAIL_SORT_LABELS,
    folderRole: core.MAIL_FOLDER_ROLE_LABELS,
    markRead: core.MAIL_MARK_READ_LABELS,
    afterFiling: core.MAIL_AFTER_FILING_LABELS,
    mailboxScope: core.MAIL_MAILBOX_SCOPE_LABELS
};

describe.each([
    ["tasks", TASKS],
    ["mail", MAIL]
] as const)("the %s option labels", (namespace, groups) => {
    const english = webCatalogs.catalogs["en-US"][namespace].labels as Record<string, Record<string, string>>;

    it.each(Object.keys(groups))("%s is core's English, for every value", (group) => {
        const expected = Object.fromEntries(Object.entries(groups[group] ?? {}).map(([value, label]) => [keyOf(value), label]));
        expect(english[group]).toEqual(expected);
    });

    it("carries no group core does not have", () => {
        expect(Object.keys(english).sort()).toEqual(Object.keys(groups).sort());
    });
});
