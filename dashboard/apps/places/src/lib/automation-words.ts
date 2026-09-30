/**
 * An automation in the reader's words: one sentence per trigger, condition and
 * step, and one per run of the log.
 *
 * Written as sentences here rather than assembled on screen, for the reason the
 * device history is: the list, the editor's collapsed cards and the run log all
 * say the same thing about the same node, and three screens building it from
 * parts would word it three ways.
 *
 * Pure and client-safe.
 */

import * as kinds from "./device-kinds";
import * as auto from "./automation-kinds";
import { weekdayNames } from "@polaris/core";
import type { PlacesTranslator } from "./i18n";
import type { PlacesKey } from "../../messages";
import { placesRefusalText } from "./refusal-text";

/** What the sentences need to know about a device, by id. */
export interface DeviceLookup {
    (id: string): { readonly name: string; readonly kind: string } | undefined;
}

export function triggerKindText(kind: auto.TriggerKind, t: PlacesTranslator): string {
    return t(`automations.triggers.${kind}`);
}

export function conditionKindText(kind: auto.ConditionKind, t: PlacesTranslator): string {
    return t(`automations.conditions.${kind}`);
}

export function stepKindText(kind: auto.StepKind, t: PlacesTranslator): string {
    return t(`automations.steps.${kind}`);
}

export function attributeText(attribute: auto.AutomationAttribute, t: PlacesTranslator): string {
    return t(`automations.attributes.${attribute}`);
}

export function stepActionText(action: auto.StepDeviceAction, t: PlacesTranslator): string {
    return action === auto.TOGGLE ? t("automations.toggle") : kinds.actionText(action, t);
}

/** One value of an attribute, as the device's own row would show it. */
export function valueText(
    attribute: auto.AutomationAttribute,
    kind: string,
    value: string,
    t: PlacesTranslator
): string {
    if (!value) return t("automations.anyValue");
    if (attribute === "state") return kinds.stateLabel(kind, kinds.deviceState(value), t);
    if (attribute === "door") return kinds.doorText(kinds.doorState(value), t) || value;
    return kinds.readingLine({ value, unit: "" }, t);
}

/** A span of minutes or seconds in the shortest words that say it exactly. */
export function durationText(seconds: number, t: PlacesTranslator): string {
    if (!Number.isFinite(seconds)) return "";
    if (seconds % 3600 === 0) return t("automations.units.hours", { count: seconds / 3600 });
    if (seconds % 60 === 0) return t("automations.units.minutes", { count: seconds / 60 });
    return t("automations.units.seconds", { count: seconds });
}

/** The weekdays of a time, as the fewest words: every day, weekdays, weekends,
 *  or the short names. */
export function daysText(days: readonly number[], t: PlacesTranslator): string {
    const set = [...new Set(days)].sort((a, b) => a - b);
    const which =
        set.length === 7 ? "every" : set.join() === "1,2,3,4,5" ? "weekdays" : set.join() === "0,6" ? "weekends" : "other";
    const names = weekdayNames(t.locale, "short");
    // Monday first, which is how a week is read in both languages here.
    const list = [...set]
        .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
        .map((day) => names[day] ?? "")
        .join(", ");
    return t("automations.days", { which, list });
}

const COMPARISON_KEYS: Readonly<Record<auto.Comparison, PlacesKey>> = {
    gt: "automations.compare.gt",
    gte: "automations.compare.gte",
    lt: "automations.compare.lt",
    lte: "automations.compare.lte",
    eq: "automations.compare.eq",
    ne: "automations.compare.ne"
};

export function comparisonText(op: auto.Comparison, t: PlacesTranslator): string {
    return t(COMPARISON_KEYS[op]);
}

function deviceName(lookup: DeviceLookup, id: string, t: PlacesTranslator): { name: string; kind: string } {
    const found = lookup(id);
    return found ? { name: found.name, kind: found.kind } : { name: t("automations.missingDevice"), kind: "" };
}

export function describeTrigger(trigger: auto.Trigger, lookup: DeviceLookup, t: PlacesTranslator): string {
    switch (trigger.kind) {
        case "time":
            return t("automations.say.time", { time: trigger.at, days: daysText(trigger.days, t) });
        case "interval":
            return t("automations.say.interval", { every: durationText(trigger.minutes * 60, t) });
        case "manual":
            return t("automations.say.manual");
        case "threshold": {
            const device = deviceName(lookup, trigger.deviceId, t);
            return t("automations.say.threshold", {
                device: device.name,
                direction: trigger.direction,
                value: Number.isFinite(trigger.value) ? String(trigger.value) : "?"
            });
        }
        case "change": {
            const device = deviceName(lookup, trigger.deviceId, t);
            return t("automations.say.change", {
                device: device.name,
                what: attributeText(trigger.attribute, t),
                from: valueText(trigger.attribute, device.kind, trigger.from, t),
                to: valueText(trigger.attribute, device.kind, trigger.to, t),
                hasFrom: trigger.from ? "yes" : "no",
                hasTo: trigger.to ? "yes" : "no"
            });
        }
        case "stays": {
            const device = deviceName(lookup, trigger.deviceId, t);
            return t("automations.say.stays", {
                device: device.name,
                value: valueText(trigger.attribute, device.kind, trigger.is, t),
                span: durationText(trigger.minutes * 60, t)
            });
        }
    }
}

export function describeCondition(condition: auto.Condition, lookup: DeviceLookup, t: PlacesTranslator): string {
    switch (condition.kind) {
        case "device": {
            const device = deviceName(lookup, condition.deviceId, t);
            return t("automations.say.is", {
                device: device.name,
                value: valueText(condition.attribute, device.kind, condition.is, t),
                negate: condition.negate ? "yes" : "no"
            });
        }
        case "reading": {
            const device = deviceName(lookup, condition.deviceId, t);
            return t("automations.say.reading", {
                device: device.name,
                compare: comparisonText(condition.op, t),
                value: Number.isFinite(condition.value) ? String(condition.value) : "?"
            });
        }
        case "time":
            return t("automations.say.between", { from: condition.from, to: condition.to });
        case "weekday":
            return t("automations.say.on", { days: daysText(condition.days, t) });
    }
}

export function describeStep(
    step: auto.Step,
    lookup: DeviceLookup,
    automationName: (id: string) => string | undefined,
    t: PlacesTranslator
): string {
    switch (step.kind) {
        case "device": {
            const device = deviceName(lookup, step.deviceId, t);
            return t("automations.say.act", { action: stepActionText(step.do, t), device: device.name });
        }
        case "delay":
            return t("automations.say.delay", { span: durationText(step.seconds, t) });
        case "wait": {
            const device = deviceName(lookup, step.deviceId, t);
            return t("automations.say.wait", {
                device: device.name,
                value: valueText(step.attribute, device.kind, step.is, t),
                span: durationText(step.timeoutMinutes * 60, t)
            });
        }
        case "notify":
            return t("automations.say.notify", { message: step.message });
        case "run":
            return t("automations.say.run", {
                name: automationName(step.automationId) ?? t("automations.missingAutomation")
            });
    }
}

/** Why a run fired, as its log line opens. */
export function describeCause(cause: auto.RunCause, lookup: DeviceLookup, t: PlacesTranslator): string {
    if (cause.kind === "automation") return t("automations.cause.automation", { name: cause.byName ?? "" });
    if (cause.kind === "manual") return t("automations.cause.manual", { name: cause.byUser ?? "" });
    if (cause.kind === "time") return t("automations.cause.time");
    if (cause.kind === "interval") return t("automations.cause.interval");
    const device = deviceName(lookup, cause.deviceId ?? "", t);
    const attribute = cause.attribute ?? "state";
    if (cause.kind === "stays") {
        return t("automations.cause.stays", {
            device: device.name,
            value: valueText(attribute, device.kind, cause.to ?? "", t),
            span: durationText((cause.minutes ?? 0) * 60, t)
        });
    }
    return t("automations.cause.change", {
        device: device.name,
        from: valueText(attribute, device.kind, cause.from ?? "", t),
        to: valueText(attribute, device.kind, cause.to ?? "", t)
    });
}

export function runStatusText(status: auto.RunStatus, t: PlacesTranslator): string {
    return t(`automations.status.${status}`);
}

/** How a run's status reads at a glance, as the device states do. */
export const RUN_TONES: Readonly<Record<auto.RunStatus, kinds.DeviceTone>> = {
    queued: "muted",
    waiting: "active",
    running: "active",
    succeeded: "success",
    failed: "danger",
    skipped: "muted",
    stopped: "muted",
    refused: "danger",
    limited: "warning"
};

const REASONS = [
    "conditions",
    "owner",
    "loop",
    "limited",
    "disabled",
    "edited",
    "timedOut",
    "step",
    "fault",
    "unreadable"
] as const;

/** Why a run stopped where it did, or nothing when it did not stop early. */
export function reasonText(reason: string | null, t: PlacesTranslator): string {
    if (!reason) return "";
    return (REASONS as readonly string[]).includes(reason) ? t(`automations.reasons.${reason as (typeof REASONS)[number]}`) : "";
}

const NOTES = [
    "deviceGone",
    "owner",
    "loop",
    "failed",
    "notifyFailed",
    "automationGone",
    "automationOff",
    "automationHeld",
    "toggleUnknown"
] as const;

/** What one step's result says, in the reader's words: a note Places wrote by
 *  key, or a refusal the device service wrote in English. */
export function stepNoteText(log: auto.StepLog, t: PlacesTranslator): string {
    if (log.said) return placesRefusalText(t, log.said);
    if (log.code && (NOTES as readonly string[]).includes(log.code)) {
        return t(`automations.notes.${log.code as (typeof NOTES)[number]}`);
    }
    return "";
}

export function stepOutcomeText(outcome: auto.StepOutcome, t: PlacesTranslator): string {
    return t(`automations.outcomes.${outcome}`);
}

/** A schema complaint in the reader's words. The schema's messages are keys under
 *  `automations.errors`; anything else is Zod's own English and is replaced with
 *  the generic line rather than shown. */
export function issueText(message: string, t: PlacesTranslator): string {
    return t.has(message) && message.startsWith("automations.errors.")
        ? t(message as PlacesKey)
        : t("automations.errors.broken");
}

/** What "turn it off after a while" is called when it is made for one device:
 *  "Turn off Porch light after 30 minutes", or "Lock Front door after ..." for
 *  a lock. */
export function autoOffName(device: { readonly name: string; readonly kind: string }, minutes: number, t: PlacesTranslator): string {
    const span = t("automations.units.minutes", { count: minutes });
    const name =
        auto.autoOffPlan(device.kind)?.do === "lock"
            ? t("automations.templates.autoOff.lockName", { device: device.name, span })
            : t("automations.templates.autoOff.offName", { device: device.name, span });
    return name.slice(0, auto.LIMITS.name);
}
