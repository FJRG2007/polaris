/**
 * Server templates: the state a server is expected to be in - packages present,
 * services running and starting at boot, files with a given content and mode,
 * kernel settings, login accounts and firewall openings - checked on a schedule
 * and put back on request.
 *
 * Every value here ends up as a positional argument to a fixed script on the
 * server, never inside the script, so the patterns below are not what keeps a
 * shell out. They keep the values to what the tools on the other end accept, so
 * a typo is refused while typing rather than reported later as drift that no fix
 * can clear.
 */

import { z } from "zod";

const trimmed = (max: number) => z.string().trim().min(1).max(max);

/** Debian, RPM and Alpine package names share this alphabet. */
export const templatePackageSchema = trimmed(128).regex(/^[a-z0-9][a-z0-9.+_-]*$/, "packageName");

/** A systemd unit name; `.service` may be left off. */
export const templateServiceSchema = z.object({
    name: trimmed(128).regex(/^[A-Za-z0-9][A-Za-z0-9@._:-]*$/, "serviceName"),
    running: z.boolean().default(true),
    enabled: z.boolean().default(true)
});

/** Most of a file a template may carry. It travels on stdin, base64-encoded. */
export const TEMPLATE_FILE_MAX = 32 * 1024;

export const templateFileSchema = z.object({
    path: trimmed(512)
        .regex(/^\/[^\0-\x1f\x7f]*$/, "filePath")
        .refine((path) => !path.split("/").includes(".."), "filePath")
        .refine((path) => !path.endsWith("/"), "filePath"),
    content: z
        .string()
        .max(TEMPLATE_FILE_MAX)
        .refine((text) => !text.includes("\0"), "fileContent"),
    mode: z
        .string()
        .trim()
        .regex(/^0?[0-7]{3}$/, "fileMode")
        .transform((mode) => mode.replace(/^0(?=\d{3}$)/, ""))
        .default("644")
});

export const templateSysctlSchema = z.object({
    key: trimmed(128).regex(/^[a-z0-9_][a-z0-9_.-]*$/, "sysctlKey"),
    value: trimmed(256).regex(/^[^\0-\x1f\x7f]+$/, "sysctlValue")
});

const accountName = trimmed(32).regex(/^[a-z_][a-z0-9_-]*\$?$/, "userName");

export const templateUserSchema = z.object({
    name: accountName,
    groups: z.array(accountName).max(20).default([])
});

export const templateFirewallSchema = z.object({
    port: z.coerce.number().int().min(1).max(65535),
    protocol: z.enum(["tcp", "udp"]).default("tcp")
});

/** The expected state itself. Each list is short on purpose: a check runs all
 *  of it over one SSH command.
 *
 *  An item may appear once. Two entries for one file, setting or unit with
 *  different values would each be drift whenever the other was put back - a
 *  difference no fix can ever clear - so the second is refused as typed. */
export const templateSpecSchema = z
    .object({
        packages: z.array(templatePackageSchema).max(100).default([]),
        services: z.array(templateServiceSchema).max(50).default([]),
        files: z.array(templateFileSchema).max(30).default([]),
        sysctl: z.array(templateSysctlSchema).max(50).default([]),
        users: z.array(templateUserSchema).max(30).default([]),
        firewall: z.array(templateFirewallSchema).max(50).default([])
    })
    .superRefine((spec, ctx) => {
        const once = <T>(
            list: readonly T[],
            identity: (item: T) => string,
            path: (index: number) => (string | number)[]
        ) => {
            const seen = new Set<string>();
            list.forEach((item, index) => {
                const id = identity(item);
                if (seen.has(id))
                    ctx.addIssue({ code: "custom", message: "duplicate", path: path(index) });
                seen.add(id);
            });
        };
        once(
            spec.packages,
            (name) => name,
            (i) => ["packages", i]
        );
        // `nginx` and `nginx.service` are the same unit.
        once(
            spec.services,
            (svc) => svc.name.replace(/\.service$/, ""),
            (i) => ["services", i, "name"]
        );
        once(
            spec.files,
            (file) => file.path,
            (i) => ["files", i, "path"]
        );
        once(
            spec.sysctl,
            (entry) => entry.key,
            (i) => ["sysctl", i, "key"]
        );
        once(
            spec.users,
            (user) => user.name,
            (i) => ["users", i, "name"]
        );
        once(
            spec.firewall,
            (rule) => `${rule.port}/${rule.protocol}`,
            (i) => ["firewall", i, "port"]
        );
    });

export type TemplateSpec = z.infer<typeof templateSpecSchema>;
export type TemplateSpecInput = z.input<typeof templateSpecSchema>;

export const hostTemplateInputSchema = z.object({
    name: trimmed(80),
    description: z.string().trim().max(500).default(""),
    spec: templateSpecSchema
});

export type HostTemplateInput = z.input<typeof hostTemplateInputSchema>;

export const hostTemplateIdSchema = z.string().uuid();

export const templateAssignInputSchema = z.object({
    templateId: z.string().uuid(),
    hostId: z.string().uuid(),
    autoFix: z.boolean().default(false)
});

export const templateFixInputSchema = z.object({
    assignmentId: z.string().uuid(),
    /** The drift items to fix, by key; none means every fixable one. */
    keys: z.array(z.string().min(1).max(600)).max(400).optional()
});

/** How an assignment last checked out. */
export const TEMPLATE_STATUSES = ["unknown", "compliant", "drifted", "failed"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** One difference between a template and its server, in words the screen
 *  renders from `code`. */
export const DRIFT_CODES = [
    "packageMissing",
    "serviceStopped",
    "serviceRunning",
    "serviceNotEnabled",
    "serviceEnabled",
    "fileMissing",
    "fileContent",
    "fileMode",
    "sysctlValue",
    "userMissing",
    "userGroups",
    "firewallMissing",
    "firewallOff",
    "firewallAbsent",
    "unreadable"
] as const;

export type DriftCode = (typeof DRIFT_CODES)[number];

export interface DriftItem {
    /** Stable for one template item, so a fix can name it. */
    readonly key: string;
    readonly code: DriftCode;
    readonly name: string;
    readonly expected?: string;
    readonly actual?: string;
    /** Whether Fix can put this one back. */
    readonly fixable: boolean;
}
