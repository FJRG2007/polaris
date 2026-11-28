/**
 * Automation steps an installed app declares in its own manifest
 * (`automationSteps`, docs/addons-delivery.md), registered when the manifest is
 * read: the editor lists them under the app, draws their settings from the
 * declared fields, and the engine checks a step's settings and its answer
 * against them. An app never edits core or the dashboard to add one.
 *
 * Each step is `<app id>.action.<name>`, stands behind one of the app's own
 * permissions, and goes when the app does.
 */

import { z } from "zod";

/** A record's id as an app hands it over, the same rule its events use. */
const id = z.string().min(1).max(64);

export const APP_STEP_FIELD_KINDS = ["string", "text", "number", "boolean", "id", "choice"] as const;
export type AppStepFieldKind = (typeof APP_STEP_FIELD_KINDS)[number];

export const APP_STEP_OUTPUT_KINDS = ["string", "number", "boolean", "id"] as const;
export type AppStepOutputKind = (typeof APP_STEP_OUTPUT_KINDS)[number];

export interface AppStepField {
    readonly key: string;
    readonly kind: AppStepFieldKind;
    readonly label: string;
    readonly hint?: string;
    readonly required?: boolean;
    /** The longest a string or text may be, and the bounds of a number. */
    readonly max?: number;
    readonly min?: number;
    /** A choice's options, in the order they are offered. */
    readonly options?: readonly { readonly value: string; readonly label: string }[];
}

export interface AppStepDefinition {
    /** `<app id>.action.<name>`. */
    readonly type: string;
    readonly label: string;
    readonly description: string;
    /** What the run-as account needs: one of the app's own permissions. */
    readonly permission: string;
    readonly fields: readonly AppStepField[];
    /** What the step answers, which later steps can refer to. */
    readonly output: Readonly<Record<string, AppStepOutputKind>>;
}

export interface RegisteredAppStep extends AppStepDefinition {
    readonly app: string;
    readonly appName: string;
}

const stepRegistry = ((globalThis as Record<symbol, unknown>)[Symbol.for("polaris.automation.app-steps")] ??=
    new Map()) as Map<string, RegisteredAppStep>;

const STEP_TYPE = /^[a-z][a-z0-9-]{1,47}\.action\.[a-z][a-zA-Z0-9-]{0,47}$/;
const KEY = /^[a-z][a-zA-Z0-9]{0,39}$/;
const MAX_STEPS = 32;
const MAX_FIELDS = 16;

function readableField(field: AppStepField): boolean {
    if (!KEY.test(field.key) || !APP_STEP_FIELD_KINDS.includes(field.kind)) return false;
    if (field.kind !== "choice") return true;
    const options = field.options ?? [];
    return options.length > 0 && options.length <= 50 && new Set(options.map((option) => option.value)).size === options.length;
}

/**
 * Register (or replace) the steps an app declares. One outside the app's id,
 * behind a permission that is not the app's, or with an unreadable field or
 * output is left out: an app adds steps, it never borrows somebody else's.
 */
export function registerAppSteps(app: string, appName: string, definitions: readonly AppStepDefinition[]): void {
    for (const [type, step] of stepRegistry) if (step.app === app) stepRegistry.delete(type);
    for (const definition of definitions.slice(0, MAX_STEPS)) {
        if (!STEP_TYPE.test(definition.type) || !definition.type.startsWith(`${app}.action.`)) continue;
        if (!definition.permission.startsWith(`${app}.`)) continue;
        const fields = definition.fields;
        if (fields.length > MAX_FIELDS || !fields.every(readableField)) continue;
        if (new Set(fields.map((field) => field.key)).size !== fields.length) continue;
        const output = Object.entries(definition.output);
        if (output.length > 32 || output.some(([key, kind]) => !KEY.test(key) || !APP_STEP_OUTPUT_KINDS.includes(kind))) continue;
        stepRegistry.set(definition.type, {
            ...definition,
            app,
            appName,
            label: definition.label.slice(0, 80),
            description: definition.description.slice(0, 300)
        });
    }
}

/** Forget every app's registered steps except those of `keep`. */
export function retainAppSteps(keep: Iterable<string>): void {
    const kept = new Set(keep);
    for (const [type, step] of stepRegistry) if (!kept.has(step.app)) stepRegistry.delete(type);
}

/** One registered step, or null for a type no installed manifest declares. */
export function appStep(type: string): RegisteredAppStep | null {
    return stepRegistry.get(type) ?? null;
}

/** Every registered step, in the order the apps declared them. */
export function appSteps(): RegisteredAppStep[] {
    return [...stepRegistry.values()];
}

function fieldSchema(field: AppStepField): z.ZodTypeAny {
    const optional = (schema: z.ZodTypeAny) => (field.required ? schema : schema.optional());
    switch (field.kind) {
        case "number": {
            let schema = z.number().finite();
            if (field.min !== undefined) schema = schema.min(field.min);
            if (field.max !== undefined) schema = schema.max(field.max);
            return optional(schema);
        }
        case "boolean":
            return field.required ? z.boolean() : z.boolean().default(false);
        case "id":
            return optional(id);
        case "choice": {
            const values = (field.options ?? []).map((option) => option.value);
            return optional(z.string().refine((value) => values.includes(value), "Not one of the options"));
        }
        default: {
            const limit = Math.min(field.max ?? (field.kind === "text" ? 4_000 : 200), 20_000);
            const text = z.string().trim().max(limit);
            return field.required ? text.min(1) : text.optional();
        }
    }
}

/** A step's settings as its fields declare them: strict, so nothing undeclared rides along. */
export function appStepConfigSchema(step: Pick<AppStepDefinition, "fields">): z.ZodType<Record<string, unknown>> {
    return z.object(Object.fromEntries(step.fields.map((field) => [field.key, fieldSchema(field)]))).strict();
}

function outputSchema(kind: AppStepOutputKind): z.ZodTypeAny {
    if (kind === "number") return z.number().finite();
    if (kind === "boolean") return z.boolean();
    if (kind === "id") return id;
    return z.string().max(2_000);
}

/** A step's answer checked against what it declared: the data, or null when it does not match. */
export function parseAppStepOutput(
    step: Pick<AppStepDefinition, "output">,
    value: unknown
): Record<string, unknown> | null {
    const shape = Object.fromEntries(Object.entries(step.output).map(([key, kind]) => [key, outputSchema(kind)]));
    const parsed = z.object(shape).strict().safeParse(value);
    return parsed.success ? parsed.data : null;
}
