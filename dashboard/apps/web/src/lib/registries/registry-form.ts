/**
 * The shape of a container registry login, shared by the form and the server.
 *
 * Pure: no database and no secrets, so the browser validates against exactly
 * the schema the server action checks again. Messages are keys of the
 * `deployRegistries` namespace, translated where they are shown.
 */

import { z } from "zod";

export const REGISTRY_KINDS = ["dockerhub", "ghcr", "gitlab", "generic"] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

/** The host each kind signs in to unless the reader names another (a
 *  self-managed GitLab answers on its own host). */
export const REGISTRY_DEFAULT_HOST: Readonly<Record<RegistryKind, string>> = {
    dockerhub: "docker.io",
    ghcr: "ghcr.io",
    gitlab: "registry.gitlab.com",
    generic: ""
};

export const REGISTRY_NAME_MAX = 80;
export const REGISTRY_USERNAME_MAX = 200;
export const REGISTRY_SECRET_MAX = 4096;

/** A host name or IPv4 address, with an optional port. */
const HOST_PATTERN =
    /^(?=.{1,253}(?::\d{1,5})?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

/** Lowercased, without a scheme, a path or a trailing slash. Docker Hub's own
 *  sign-in hosts all mean "docker.io". */
export function normalizeRegistryHost(input: string): string {
    const bare = input
        .trim()
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "")
        .replace(/\/.*$/, "");
    if (
        bare === "index.docker.io" ||
        bare === "registry-1.docker.io" ||
        bare === "hub.docker.com"
    ) {
        return "docker.io";
    }
    return bare;
}

export interface RegistryFormValues {
    kind: RegistryKind;
    name: string;
    host: string;
    username: string;
    password: string;
}

/** One normalizer for both sides: trimmed text, a canonical host, and the
 *  kind's own host when the field is left empty. The secret is kept as typed. */
export function normalizeRegistryForm(values: RegistryFormValues): RegistryFormValues {
    const host = normalizeRegistryHost(values.host);
    return {
        kind: values.kind,
        name: values.name.trim(),
        host: host || REGISTRY_DEFAULT_HOST[values.kind] || "",
        username: values.username.trim(),
        password: values.password
    };
}

const baseSchema = z.object({
    kind: z.enum(REGISTRY_KINDS, { message: "form.kindRequired" }),
    name: z.string().max(REGISTRY_NAME_MAX, { message: "form.nameTooLong" }),
    host: z
        .string()
        .min(1, { message: "form.hostRequired" })
        .regex(HOST_PATTERN, { message: "form.hostInvalid" }),
    username: z
        .string()
        .min(1, { message: "form.usernameRequired" })
        .max(REGISTRY_USERNAME_MAX, { message: "form.usernameTooLong" })
        .regex(/^[^\s:]+$/, { message: "form.usernameInvalid" }),
    password: z.string().max(REGISTRY_SECRET_MAX, { message: "form.secretTooLong" })
});

/** A new login: the secret is required. */
export const registryCreateSchema = baseSchema.extend({
    password: baseSchema.shape.password.min(1, { message: "form.secretRequired" })
});

/** An edit: an empty secret keeps the stored one. */
export const registryUpdateSchema = baseSchema;

export type RegistryInput = z.infer<typeof baseSchema>;

/** Field-by-field first problem, for the form. Keys are message keys. */
export function registryFormIssues(
    values: RegistryFormValues,
    editing: boolean
): Partial<Record<keyof RegistryFormValues, string>> {
    const schema = editing ? registryUpdateSchema : registryCreateSchema;
    const parsed = schema.safeParse(normalizeRegistryForm(values));
    if (parsed.success) return {};
    const issues: Partial<Record<keyof RegistryFormValues, string>> = {};
    for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof RegistryFormValues | undefined;
        if (field && !issues[field]) issues[field] = issue.message;
    }
    return issues;
}
