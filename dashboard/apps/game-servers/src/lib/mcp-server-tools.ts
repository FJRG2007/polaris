/**
 * Announcements, restarts and worlds, as tools a connected assistant can call.
 *
 * Each is a screen's own buttons, held to the grant that screen is held to and
 * leaving the same audit line, marked as coming from an assistant:
 *
 * - announcements and their templates are the console grant (`games.console`),
 *   as the announce dialog is - it is the server talking to everybody on it.
 *   Reading the templates is `gameservers.read`; sending one and keeping them
 *   is `gameservers.manage`. Minecraft only, the game Polaris announces on;
 * - a restart booked for later (when nobody is on, or at a time) is seen with
 *   `games.read` and booked or called off with `games.manage`, on every game;
 * - a Minecraft server's worlds and backups are seen with `games.read`, and
 *   backing up and restoring are `games.manage`, the World screen's grants:
 *   both write into the world volume, and a restore decides which map the
 *   server comes back on.
 *
 * Server-only.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { host } from "@polaris/app-host";
import { isBackupName } from "./minecraft/world";
import { MAX_RESTART_REASON } from "./games-restart";
import type { AppHostTypes } from "@polaris/app-host";
import { announceNow } from "./minecraft/live-display-service";
import { getGameSchedule } from "./minecraft/schedule-service";
import { attempt, onlyFor, refuse, serverFor, serverId } from "./mcp-common";
import { announcementSchema, MAX_TEMPLATE_NAME } from "./minecraft/announcement-templates";
import { cancelRestart, readRestartRequest, requestRestart } from "./games-restart-service";
import { createWorldBackup, readWorldView, restoreWorldBackup } from "./minecraft/world-service";
import { deleteTemplate, listTemplates, saveTemplate } from "./minecraft/announcement-template-service";

type McpTool = AppHostTypes["McpTool"];

const { recordAudit } = host.auditService;

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

const announcement = announcementSchema.describe(
    'What to put on the players\' screens. target: "@a" for everybody, "@ops" for the operators on, "@others" for everybody else, or one player\'s name. title and subtitle: the big text in the middle; actionbar: the line above the hotbar; chat: a chat message (up to 4 lines). At least one of them. & colour codes work. hold: "timed" (the fade timings, in seconds), "until" (with until, an ISO moment) or "manual" (stays until taken down on the screen).'
);

const templatesTool = () =>
    host.mcp.defineTool({
        name: "games_announcement_templates",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "A Minecraft server's announcement templates",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "The announcements a Minecraft server keeps ready to send, with what each says. Needs the console on that server. Read-only; games_announce sends one.",
        input: z.object({ serverId }),
        category: "games",
        scope: "gameservers.read",
        readOnly: true,
        async run(input, caller) {
            const { access } = await serverFor(caller, input.serverId, "games.console");
            onlyFor(access, ["minecraft"], "Announcements");
            const templates = await attempt(() => listTemplates(input.serverId));
            if (templates.length === 0)
                return { text: "No templates.", structured: { serverId: input.serverId, templates } };
            return {
                text: templates
                    .map((template) => {
                        const said = [template.announcement.title, template.announcement.chat]
                            .filter(Boolean)
                            .join(" / ");
                        return `${template.id}  ${template.name}${said ? `: ${said}` : ""}`;
                    })
                    .join("\n"),
                structured: { serverId: input.serverId, templates }
            };
        }
    });

const announceInput = z
    .object({
        serverId,
        templateId: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .optional()
            .describe("Send this template, as games_announcement_templates listed it."),
        announcement: announcement.optional()
    })
    .refine((input) => Boolean(input.templateId) !== Boolean(input.announcement), {
        message: "Give a templateId or an announcement, not both."
    });

const announceTool = () =>
    host.mcp.defineTool({
        name: "games_announce",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Announce on a Minecraft server",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Put an announcement on the screens of the players on a Minecraft server now, as the announce dialog does: a template it keeps, or one written here. Everybody it is aimed at sees it at once; confirm the words with the person first.",
        input: announceInput,
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.console");
            onlyFor(access, ["minecraft"], "Announcements");
            const chosen = input.templateId
                ? ((await attempt(() => listTemplates(input.serverId))).find(
                      (template) => template.id === input.templateId
                  )?.announcement ?? refuse("That server keeps no template with that id."))
                : input.announcement!;
            const { sent, kept } = await attempt(() =>
                announceNow(access.ownerId, input.serverId, chosen, user.id)
            );
            await recordAudit({
                actorId: user.id,
                action: "games.announce",
                targetType: "installedApp",
                targetId: input.serverId,
                metadata: {
                    target: chosen.target,
                    title: chosen.title,
                    chat: chosen.chat,
                    hold: chosen.hold,
                    via: "mcp"
                }
            });
            return {
                text: `Sent to ${sent} on ${access.install.name}${kept ? ", and kept up" : ""}.`,
                structured: { serverId: input.serverId, sent, kept }
            };
        }
    });

const saveTemplateInput = z.object({
    serverId,
    id: z
        .string()
        .uuid()
        .optional()
        .describe("A template to rewrite. Leave out to keep a new one."),
    name: z.string().trim().min(1).max(MAX_TEMPLATE_NAME).describe("What it is called on the list."),
    announcement
});

const saveTemplateTool = () =>
    host.mcp.defineTool({
        name: "games_announcement_template_save",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Keep an announcement template",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Keep an announcement on a Minecraft server's list to send later, or rewrite one already on it. Nothing is sent.",
        input: saveTemplateInput,
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.console");
            onlyFor(access, ["minecraft"], "Announcements");
            const id = input.id ?? randomUUID();
            await attempt(() =>
                saveTemplate(input.serverId, { id, name: input.name, announcement: input.announcement })
            );
            await recordAudit({
                actorId: user.id,
                action: "games.announce.template-save",
                targetType: "installedApp",
                targetId: input.serverId,
                metadata: { id, name: input.name, via: "mcp" }
            });
            return {
                text: `Kept "${input.name}" on ${access.install.name}.`,
                structured: { serverId: input.serverId, id, name: input.name }
            };
        }
    });

const deleteTemplateTool = () =>
    host.mcp.defineTool({
        name: "games_announcement_template_delete",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Delete an announcement template",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Take an announcement template off a Minecraft server's list. It cannot be brought back.",
        input: z.object({
            serverId,
            templateId: z.string().trim().min(1).max(64).describe("As games_announcement_templates listed it.")
        }),
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.console");
            onlyFor(access, ["minecraft"], "Announcements");
            const templates = await attempt(() => listTemplates(input.serverId));
            if (!templates.some((template) => template.id === input.templateId))
                return {
                    text: `${access.install.name} keeps no template with that id.`,
                    structured: { serverId: input.serverId, templateId: input.templateId, deleted: false }
                };
            await attempt(() => deleteTemplate(input.serverId, input.templateId));
            await recordAudit({
                actorId: user.id,
                action: "games.announce.template-delete",
                targetType: "installedApp",
                targetId: input.serverId,
                metadata: { id: input.templateId, via: "mcp" }
            });
            return {
                text: `Deleted the template from ${access.install.name}.`,
                structured: { serverId: input.serverId, templateId: input.templateId, deleted: true }
            };
        }
    });

// ---------------------------------------------------------------------------
// Restarts
// ---------------------------------------------------------------------------

const restartsTool = () =>
    host.mcp.defineTool({
        name: "games_restarts",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "A game server's planned restarts",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "The restart a game server is waiting on (when nobody is on, or at a time) and why, and the restarts its schedule runs on given days. Read-only; games_restart_schedule books one, games_restart_cancel calls it off.",
        input: z.object({ serverId }),
        category: "games",
        scope: "gameservers.read",
        readOnly: true,
        async run(input, caller) {
            await serverFor(caller, input.serverId, "games.read");
            const [pending, schedule] = await Promise.all([
                readRestartRequest(input.serverId),
                getGameSchedule(input.serverId).catch(() => null)
            ]);
            const routines =
                schedule?.enabled === true
                    ? schedule.routines
                          .filter(
                              (routine) =>
                                  routine.enabled &&
                                  routine.actions.some((action) => action.kind === "restart")
                          )
                          .map((routine) => ({
                              name: routine.name,
                              at: routine.at,
                              days: routine.days,
                              timezone: schedule.timezone
                          }))
                    : [];
            const booked = pending
                ? {
                      when: pending.when,
                      at: pending.at,
                      reason: pending.reason,
                      requestedAt: pending.requestedAt
                  }
                : null;
            const lines = [
                booked
                    ? `Waiting on a restart ${booked.when === "empty" ? "for when nobody is on" : `at ${booked.at}`}${booked.reason ? `: ${booked.reason}` : ""}.`
                    : "No restart booked.",
                ...routines.map(
                    (routine) =>
                        `Schedule: "${routine.name}" restarts at ${routine.at} (${routine.timezone})${routine.days.length > 0 ? ` on days ${routine.days.join(",")} (0 is Sunday)` : " every day"}.`
                )
            ];
            return {
                text: lines.join("\n"),
                structured: { serverId: input.serverId, pending: booked, routines }
            };
        }
    });

const bookInput = z.object({
    serverId,
    when: z
        .enum(["empty", "at"])
        .describe("empty: as soon as nobody is on. at: at a moment, given in at."),
    at: z
        .string()
        .trim()
        .max(40)
        .optional()
        .describe("For when=at: an ISO 8601 moment in the next 30 days."),
    reason: z
        .string()
        .trim()
        .max(MAX_RESTART_REASON)
        .default("")
        .describe("Why, shown on the server's page while it waits.")
});

const bookTool = () =>
    host.mcp.defineTool({
        name: "games_restart_schedule",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Book a game server restart",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Book a restart of a game server for when nobody is on, or for a time, as its restart card does. The world is saved first. Replaces any restart already booked. games_server_power restarts now.",
        input: bookInput,
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.manage");
            if (input.when === "at" && !input.at) refuse("Say when, as an ISO 8601 moment.");
            const pending = await attempt(() =>
                requestRestart(input.serverId, {
                    when: input.when,
                    at: input.when === "at" ? (input.at ?? null) : null,
                    reason: input.reason,
                    requestedBy: user.id
                })
            );
            await recordAudit({
                actorId: user.id,
                action: "games.restart.book",
                targetType: "installedApp",
                targetId: input.serverId,
                metadata: { when: pending.when, at: pending.at ?? "", reason: pending.reason, via: "mcp" }
            });
            return {
                text: `${access.install.name} restarts ${pending.when === "empty" ? "when nobody is on" : `at ${pending.at}`}.`,
                structured: { serverId: input.serverId, when: pending.when, at: pending.at, reason: pending.reason }
            };
        }
    });

const cancelTool = () =>
    host.mcp.defineTool({
        name: "games_restart_cancel",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Call off a booked restart",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Call off the restart a game server is waiting on. Whatever it was going to apply still applies at its next start.",
        input: z.object({ serverId }),
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        idempotent: true,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.manage");
            if (!(await readRestartRequest(input.serverId)))
                return {
                    text: `${access.install.name} has no restart booked.`,
                    structured: { serverId: input.serverId, cancelled: false }
                };
            await attempt(() => cancelRestart(input.serverId));
            await recordAudit({
                actorId: user.id,
                action: "games.restart.cancel",
                targetType: "installedApp",
                targetId: input.serverId,
                metadata: { via: "mcp" }
            });
            return {
                text: `Called off the restart on ${access.install.name}.`,
                structured: { serverId: input.serverId, cancelled: true }
            };
        }
    });

// ---------------------------------------------------------------------------
// Worlds and backups
// ---------------------------------------------------------------------------

const worldsTool = () =>
    host.mcp.defineTool({
        name: "games_worlds",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "A Minecraft server's worlds and backups",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "The maps a Minecraft server has on disk and the one it plays, the backups beside them with their sizes and dates, how often one is taken and when the next is due. Needs the server's container; a stopped one says so. Read-only.",
        input: z.object({ serverId }),
        category: "games",
        scope: "gameservers.read",
        readOnly: true,
        async run(input, caller) {
            const { access } = await serverFor(caller, input.serverId, "games.read");
            onlyFor(access, ["minecraft"], "Worlds and backups");
            const view = await attempt(() => readWorldView(access.ownerId, input.serverId));
            const structured = {
                serverId: input.serverId,
                level: view.level,
                worlds: view.worlds,
                backups: view.backups,
                every: view.policy.every,
                keepLast: view.policy.keepLast,
                nextBackupAt: view.nextBackupAt,
                message: view.message
            };
            const lines = [
                ...(view.message ? [view.message] : []),
                `Plays: ${view.level}.`,
                `Worlds: ${view.worlds.length > 0 ? view.worlds.map((one) => one.level).join(", ") : "none read"}.`,
                "Backups:",
                ...(view.backups.length > 0
                    ? view.backups.map((backup) => `  ${backup.name}  ${backup.createdAt}  ${backup.sizeBytes} bytes`)
                    : ["  none"]),
                `Taken: ${view.policy.every}${view.nextBackupAt ? `, next ${view.nextBackupAt}` : ""}.`
            ];
            return { text: lines.join("\n"), structured };
        }
    });

const backupTool = () =>
    host.mcp.defineTool({
        name: "games_backup",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Back up a Minecraft world",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Copy the world a Minecraft server plays into an archive beside it, as the World screen's Back up button does. Takes a while on a large map; the server stays up.",
        input: z.object({ serverId }),
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.manage");
            onlyFor(access, ["minecraft"], "A world backup");
            const backup = await attempt(() => createWorldBackup(access.ownerId, input.serverId));
            await recordAudit({
                actorId: user.id,
                action: "games.world-backup",
                targetType: "installedApp",
                targetId: input.serverId,
                metadata: { name: backup.name, bytes: backup.sizeBytes, via: "mcp" }
            });
            return {
                text: `Backed up ${access.install.name}: ${backup.name} (${backup.sizeBytes} bytes).`,
                structured: { serverId: input.serverId, ...backup }
            };
        }
    });

const restoreInput = z.object({
    serverId,
    name: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .refine(isBackupName, "That is not a backup's name; games_worlds lists them.")
        .describe("The backup, as games_worlds listed it."),
    confirm: z
        .literal(true)
        .describe("True only once the person has said yes to restarting onto this backup.")
});

const restoreTool = () =>
    host.mcp.defineTool({
        name: "games_backup_restore",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Restore a Minecraft backup",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "DESTRUCTIVE: put a backed-up world back on a Minecraft server and restart it onto that map. Everybody playing is disconnected, and whatever was built since that backup is not on the map it comes back on (the map it was on is kept on disk, and can be switched back to on the World screen). Say which backup and its date to the person and wait for a yes before calling it with confirm.",
        input: restoreInput,
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.manage");
            onlyFor(access, ["minecraft"], "Restoring a backup");
            const restored = await attempt(() =>
                restoreWorldBackup(access.ownerId, input.serverId, input.name, user.id)
            );
            await recordAudit({
                actorId: user.id,
                action: "games.world-restore",
                targetType: "installedApp",
                targetId: input.serverId,
                metadata: { name: input.name, level: restored.level, via: "mcp" }
            });
            return {
                text: `Restoring ${input.name} on ${access.install.name}: it restarts onto ${restored.level}.`,
                structured: { serverId: input.serverId, backup: input.name, level: restored.level }
            };
        }
    });

export const serverTools: readonly (() => McpTool)[] = [
    templatesTool,
    announceTool,
    saveTemplateTool,
    deleteTemplateTool,
    restartsTool,
    bookTool,
    cancelTool,
    worldsTool,
    backupTool,
    restoreTool
];
