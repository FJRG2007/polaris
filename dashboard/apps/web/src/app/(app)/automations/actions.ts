"use server";

/**
 * Server actions for /automations. Every input is parsed with the same schema
 * the forms use, every refusal comes back as words from the catalog, and
 * anything unexpected is logged here and answered with a generic sentence.
 */

import { appAutomationNodeSlots } from "@/lib/app-extensions/registry";
import { z } from "zod";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { translate } from "@/lib/i18n/translate";
import * as service from "@/lib/automations/service";
import * as history from "@/lib/automations/history";
import * as secrets from "@/lib/automations/secrets";
import * as organize from "@/lib/automations/organize";
import * as appEvents from "@/lib/automations/app-events";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import type { LegacyRunRow } from "@/lib/app-extensions/types";
import type { RunActor } from "@/lib/automations/types";
import type { ChatWebhookChoice } from "@/lib/chat/webhooks";
import type {
    MessagingChannelChoice,
    ProjectWebhookChoice
} from "@/lib/automations/notice-targets";
import { listAdministeredOrgs } from "@/lib/orgs/org-service";
import { mayEditShelf, type Shelf } from "@/lib/automations/runner";

type Result<T = object> =
    ({ ok: true } & T) | { ok: false; error: string; problems?: core.GraphProblem[] };

async function actor(): Promise<RunActor> {
    const user = await requirePermission("automations.use");
    return { id: user.id, isAdmin: user.isAdmin };
}

async function openShelf(who: RunActor): Promise<Shelf> {
    const orgId = await scopeOrgIdFor(who.id);
    return { orgId, userId: orgId ? null : who.id };
}

async function failure(caught: unknown): Promise<{ ok: false; error: string }> {
    const t = await getTranslations("automations");
    if (caught instanceof service.AutomationAccessError)
        return { ok: false, error: t(`errors.${caught.code}`) };
    if (caught instanceof secrets.SecretLimitError) return { ok: false, error: t("errors.limit") };
    console.error("polaris: an automations action failed:", caught);
    return { ok: false, error: t("errors.generic") };
}

async function invalid(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: (await getTranslations("automations"))("errors.invalid") };
}

const id = z.string().uuid();

function refresh(automationId?: string): void {
    revalidatePath("/automations");
    if (automationId) revalidatePath(`/automations/${automationId}`);
}

/** Narrows the list to what one app made, and optionally to one thing of it. */
const originFilter = z
    .object({
        origin: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        originRef: z.string().min(1).max(120).nullish()
    })
    .strict();

export async function listAutomationsAction(
    from?: unknown
): Promise<
    Result<{ rows: service.AutomationRow[]; canEdit: boolean; folders: organize.FolderRow[] }>
> {
    const filter = originFilter.optional().safeParse(from ?? undefined);
    if (!filter.success) return invalid();
    try {
        const who = await actor();
        const shelf = await openShelf(who);
        const [list, folders] = await Promise.all([
            service.listAutomations(who, shelf, filter.data),
            organize.listFolders(who, shelf)
        ]);
        return { ok: true, ...list, folders };
    } catch (caught) {
        return failure(caught);
    }
}

export async function getAutomationAction(
    automationId: unknown
): Promise<Result<{ automation: service.AutomationDetail; secrets: secrets.SecretSummary[] }>> {
    const parsed = id.safeParse(automationId);
    if (!parsed.success) return invalid();
    try {
        const who = await actor();
        const [found, appNodes, eventApps] = await Promise.all([
            service.getAutomation(who, parsed.data),
            appAutomationNodeSlots().catch(() => ({})),
            requirePermission("automations.use").then((user) => appEvents.eventApps(user))
        ]);
        const unnamed = core.LOCALES.some(
            (locale) => translate(locale, "automations.create.untitled") === found.name
        );
        const automation = { ...found, appNodes, eventApps, unnamed };
        const shelf = await service.shelfOf(parsed.data);
        return {
            ok: true,
            automation,
            secrets: automation.canEdit ? await secrets.listSecrets(shelf) : []
        };
    } catch (caught) {
        return failure(caught);
    }
}

/** The ready-made automations that fit here: those whose apps are installed and usable. */
async function availableTemplates(): Promise<core.AutomationTemplate[]> {
    const user = await requirePermission("automations.use");
    return core.availableTemplates(await appEvents.eventApps(user).catch(() => []));
}

/**
 * The shelves this account may create an automation on (its own, and the
 * organizations it administers), and the templates it may start from.
 */
export async function creatableShelvesAction(): Promise<
    Result<{
        orgs: { id: string; name: string }[];
        openOrgId: string | null;
        templates: core.AutomationTemplate[];
    }>
> {
    try {
        const who = await actor();
        const [orgs, openOrgId, templates] = await Promise.all([
            listAdministeredOrgs(who),
            scopeOrgIdFor(who.id),
            availableTemplates()
        ]);
        return { ok: true, orgs, openOrgId, templates };
    } catch (caught) {
        return failure(caught);
    }
}

export async function createAutomationAction(
    input: unknown,
    timeZone: unknown
): Promise<Result<{ id: string }>> {
    const parsed = core.automationCreateSchema.safeParse(input);
    const zone = z.string().min(1).max(64).safeParse(timeZone);
    if (!parsed.success) {
        const t = await getTranslations("automations");
        const message = parsed.error.issues[0]?.message;
        return {
            ok: false,
            error: message === "nameRequired" ? t("errors.nameRequired") : t("errors.invalid")
        };
    }
    try {
        const template = parsed.data.template;
        // A template whose app is not here would start an automation nothing ever runs.
        if (template && !(await availableTemplates()).includes(template)) return invalid();
        const t = template ? await getTranslations("automations") : null;
        const params = template ? core.AUTOMATION_TEMPLATE_SPECS[template].params : {};
        const newId = await service.createAutomation(
            await actor(),
            parsed.data,
            zone.success ? zone.data : "UTC",
            t && template
                ? {
                      title: t(`templates.${template}.noticeTitle`, params),
                      body: t(`templates.${template}.noticeBody`, params)
                  }
                : undefined
        );
        refresh();
        return { ok: true, id: newId };
    } catch (caught) {
        return failure(caught);
    }
}

export async function setEnabledAction(automationId: unknown, enabled: unknown): Promise<Result> {
    const parsed = z.tuple([id, z.boolean()]).safeParse([automationId, enabled]);
    if (!parsed.success) return invalid();
    try {
        await service.setEnabled(await actor(), parsed.data[0], parsed.data[1]);
        refresh(parsed.data[0]);
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

/** The sentence for a draft that cannot be saved or published: the problem's own when it has one. */
async function problemError(
    problems: readonly core.GraphProblem[],
    fallback: "invalid" | "notReady"
): Promise<string> {
    const t = await getTranslations("automations");
    const named = problems.find((problem) =>
        ["loopBodyLeaks", "tryBodyLeaks", "scopeTooDeep", "callCycle"].includes(problem.code)
    );
    if (named?.code === "scopeTooDeep")
        return t("errors.scopeTooDeep", { max: core.AUTOMATION_LIMITS.scopeDepth });
    return t(
        `errors.${(named?.code ?? fallback) as "loopBodyLeaks" | "tryBodyLeaks" | "callCycle" | typeof fallback}`
    );
}

export async function saveDraftAction(automationId: unknown, graph: unknown): Promise<Result> {
    const parsedId = id.safeParse(automationId);
    const parsed = core.automationGraphSchema.safeParse(graph);
    if (!parsedId.success || !parsed.success) return invalid();
    try {
        const problems = await service.saveDraft(await actor(), parsedId.data, parsed.data);
        if (problems.some((problem) => problem.code !== "badConfig"))
            return { ok: false, error: await problemError(problems, "invalid"), problems };
        refresh(parsedId.data);
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

export async function publishAction(automationId: unknown): Promise<Result> {
    const parsed = id.safeParse(automationId);
    if (!parsed.success) return invalid();
    try {
        const problems = await service.publishAutomation(await actor(), parsed.data);
        if (problems.length > 0)
            return { ok: false, error: await problemError(problems, "notReady"), problems };
        refresh(parsed.data);
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

const settingsInput = core.automationSettingsSchema;

export async function updateSettingsAction(automationId: unknown, input: unknown): Promise<Result> {
    const parsedId = id.safeParse(automationId);
    const parsed = settingsInput.safeParse(input);
    if (!parsedId.success || !parsed.success) return invalid();
    try {
        await service.updateSettings(await actor(), parsedId.data, parsed.data);
        refresh(parsedId.data);
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

export async function setLocalNetworkAction(
    automationId: unknown,
    allow: unknown
): Promise<Result> {
    const parsed = z.tuple([id, z.boolean()]).safeParse([automationId, allow]);
    if (!parsed.success) return invalid();
    try {
        await service.setLocalNetwork(await actor(), parsed.data[0], parsed.data[1]);
        refresh(parsed.data[0]);
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

export async function hookAddressAction(
    automationId: unknown,
    nodeId: unknown,
    rotation: unknown
): Promise<Result<{ path: string }>> {
    const parsed = z
        .tuple([
            id,
            z.string().min(1).max(64),
            core.CORE_NODE_CONFIGS["core.webhook"].shape.rotation
        ])
        .safeParse([automationId, nodeId, rotation]);
    if (!parsed.success) return invalid();
    try {
        const [automation, node, turn] = parsed.data;
        return { ok: true, path: await service.hookAddress(await actor(), automation, node, turn) };
    } catch (caught) {
        return failure(caught);
    }
}

export async function rotateHookAction(automationId: unknown, nodeId: unknown): Promise<Result> {
    const parsed = z.tuple([id, z.string().min(1).max(64)]).safeParse([automationId, nodeId]);
    if (!parsed.success) return invalid();
    try {
        const who = await actor();
        const detail = await service.getAutomation(who, parsed.data[0]);
        const graph = structuredClone(detail.draft);
        const node = graph.nodes.find(
            (entry) => entry.id === parsed.data[1] && entry.type === "core.webhook"
        );
        if (!node) return invalid();
        const config = core.CORE_NODE_CONFIGS["core.webhook"].parse(node.config);
        node.config = { ...config, rotation: config.rotation + 1 };
        await service.saveDraft(who, parsed.data[0], graph);
        refresh(parsed.data[0]);
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

export async function deleteAutomationAction(automationId: unknown): Promise<Result> {
    const parsed = id.safeParse(automationId);
    if (!parsed.success) return invalid();
    try {
        await service.deleteAutomation(await actor(), parsed.data);
        refresh();
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

export async function runNowAction(automationId: unknown): Promise<Result> {
    const parsed = id.safeParse(automationId);
    if (!parsed.success) return invalid();
    try {
        await service.runNow(await actor(), parsed.data);
        revalidatePath("/automations/runs");
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

const runsPageInput = z.object({
    automationId: id.optional(),
    cursor: z.string().max(120).optional(),
    filter: z.enum(history.RUN_FILTERS).default("all")
});

export async function listRunsAction(
    automationId: unknown,
    page: unknown = {}
): Promise<Result<history.RunsPage>> {
    const parsed = runsPageInput.safeParse({
        ...(page && typeof page === "object" ? page : {}),
        automationId: automationId ?? undefined
    });
    if (!parsed.success) return invalid();
    try {
        const who = await actor();
        const { automationId: one, cursor, filter } = parsed.data;
        return {
            ok: true,
            ...(await history.listRuns(who, await openShelf(who), one, { cursor, filter }))
        };
    } catch (caught) {
        return failure(caught);
    }
}

export async function listLegacyRunsAction(
    automationId: unknown
): Promise<Result<{ rows: LegacyRunRow[] }>> {
    const parsed = id.safeParse(automationId);
    if (!parsed.success) return invalid();
    try {
        const who = await actor();
        return {
            ok: true,
            rows: await history.listLegacyRuns(who, await openShelf(who), parsed.data)
        };
    } catch (caught) {
        return failure(caught);
    }
}

export async function getRunAction(runId: unknown): Promise<Result<{ run: history.RunDetail }>> {
    const parsed = id.safeParse(runId);
    if (!parsed.success) return invalid();
    try {
        return { ok: true, run: await history.getRun(await actor(), parsed.data) };
    } catch (caught) {
        return failure(caught);
    }
}

const rerunInput = z.object({ runId: id, which: z.enum(["same", "published"]) });

export async function rerunAction(input: unknown): Promise<Result<{ runId: string }>> {
    const parsed = rerunInput.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        const runId = await history.rerun(await actor(), parsed.data.runId, parsed.data.which);
        revalidatePath("/automations/runs");
        return { ok: true, runId };
    } catch (caught) {
        return failure(caught);
    }
}

const testRunInput = z.object({
    automationId: id,
    triggerNodeId: z.string().min(1).max(64).optional()
});

export async function startTestRunAction(input: unknown): Promise<Result<{ runId: string }>> {
    const parsed = testRunInput.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        const answer = await history.startTestRun(
            await actor(),
            parsed.data.automationId,
            parsed.data.triggerNodeId
        );
        if ("problems" in answer)
            return {
                ok: false,
                error: (await getTranslations("automations"))("errors.notReady"),
                problems: answer.problems
            };
        return { ok: true, runId: answer.runId };
    } catch (caught) {
        return failure(caught);
    }
}

const partialRunInput = z.object({ automationId: id, nodeId: z.string().min(1).max(64) });

export async function startPartialRunAction(
    input: unknown
): Promise<Result<{ runId: string }> | { ok: false; error: string; missing: readonly string[] }> {
    const parsed = partialRunInput.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        const answer = await history.startPartialRun(
            await actor(),
            parsed.data.automationId,
            parsed.data.nodeId
        );
        const t = await getTranslations("automations");
        if ("problems" in answer)
            return { ok: false, error: t("errors.notReady"), problems: answer.problems };
        if ("refusal" in answer)
            return {
                ok: false,
                error: t(`errors.partial.${answer.refusal}`),
                missing: answer.nodes
            };
        return { ok: true, runId: answer.runId };
    } catch (caught) {
        return failure(caught);
    }
}

export async function pinRunDataAction(runId: unknown): Promise<Result<{ automationId: string }>> {
    const parsed = id.safeParse(runId);
    if (!parsed.success) return invalid();
    try {
        const pinned = await history.pinRunData(await actor(), parsed.data);
        refresh(pinned.automationId);
        return { ok: true, automationId: pinned.automationId };
    } catch (caught) {
        return failure(caught);
    }
}

export async function listVersionsAction(
    automationId: unknown
): Promise<Result<{ rows: history.VersionRow[] }>> {
    const parsed = id.safeParse(automationId);
    if (!parsed.success) return invalid();
    try {
        return { ok: true, rows: await history.listVersions(await actor(), parsed.data) };
    } catch (caught) {
        return failure(caught);
    }
}

const restoreInput = z.object({ automationId: id, versionId: id });
const renameVersionInput = z.object({
    automationId: id,
    versionId: id,
    name: core.versionNameSchema
});

export async function renameVersionAction(
    input: unknown
): Promise<Result<{ name: string | null }>> {
    const parsed = renameVersionInput.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        await history.renameVersion(
            await actor(),
            parsed.data.automationId,
            parsed.data.versionId,
            parsed.data.name
        );
        return { ok: true, name: parsed.data.name };
    } catch (caught) {
        return failure(caught);
    }
}

const compareInput = z.object({
    automationId: id,
    versionId: id,
    against: z.union([id, z.literal("draft")])
});

export async function compareVersionsAction(
    input: unknown
): Promise<Result<{ comparison: history.VersionComparison }>> {
    const parsed = compareInput.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        return {
            ok: true,
            comparison: await history.compareVersions(
                await actor(),
                parsed.data.automationId,
                parsed.data.versionId,
                parsed.data.against
            )
        };
    } catch (caught) {
        return failure(caught);
    }
}

export async function restoreVersionAction(
    input: unknown
): Promise<Result<{ graph: core.AutomationGraph }>> {
    const parsed = restoreInput.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        const graph = await history.restoreVersion(
            await actor(),
            parsed.data.automationId,
            parsed.data.versionId
        );
        refresh(parsed.data.automationId);
        return { ok: true, graph };
    } catch (caught) {
        return failure(caught);
    }
}

export async function cancelRunAction(runId: unknown): Promise<Result> {
    const parsed = id.safeParse(runId);
    if (!parsed.success) return invalid();
    try {
        await service.cancelRunFor(await actor(), parsed.data);
        revalidatePath("/automations/runs");
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

export async function listSecretsAction(): Promise<
    Result<{ rows: secrets.SecretSummary[]; canEdit: boolean }>
> {
    try {
        const who = await actor();
        const shelf = await openShelf(who);
        const user = await requirePermission("automations.use");
        const { sessionCan } = await import("@/lib/session");
        const canEdit =
            (await mayEditShelf(who, shelf)) && (await sessionCan(user, "automations.secrets"));
        return { ok: true, rows: await secrets.listSecrets(shelf), canEdit };
    } catch (caught) {
        return failure(caught);
    }
}

export async function createSecretAction(
    input: unknown
): Promise<Result<{ row: secrets.SecretSummary }>> {
    const parsed = core.secretCreateSchema.safeParse(input);
    if (!parsed.success) {
        const t = await getTranslations("automations");
        const code = parsed.error.issues[0]?.message;
        const known = ["nameRequired", "valueRequired", "urlInvalid", "basicInvalid"] as const;
        return {
            ok: false,
            error: known.includes(code as (typeof known)[number])
                ? t(`errors.${code as (typeof known)[number]}`)
                : t("errors.invalid")
        };
    }
    try {
        const user = await requirePermission("automations.secrets");
        const who = { id: user.id, isAdmin: user.isAdmin };
        const shelf = await openShelf(who);
        if (!(await mayEditShelf(who, shelf))) throw new service.AutomationAccessError("forbidden");
        const row = await secrets.createSecret(shelf, who.id, parsed.data);
        revalidatePath("/automations/secrets");
        return { ok: true, row };
    } catch (caught) {
        return failure(caught);
    }
}

export async function deleteSecretAction(secretId: unknown): Promise<Result> {
    const parsed = id.safeParse(secretId);
    if (!parsed.success) return invalid();
    try {
        const user = await requirePermission("automations.secrets");
        const who = { id: user.id, isAdmin: user.isAdmin };
        const shelf = await openShelf(who);
        if (!(await mayEditShelf(who, shelf))) throw new service.AutomationAccessError("forbidden");
        if (!(await secrets.deleteSecret(shelf, parsed.data)))
            throw new service.AutomationAccessError("notFound");
        revalidatePath("/automations/secrets");
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

const folderInput = z.object({ name: core.automationFolderNameSchema });

export async function createFolderAction(
    input: unknown
): Promise<Result<{ folder: organize.FolderRow }>> {
    const parsed = folderInput.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        const who = await actor();
        const folder = await organize.createFolder(who, await openShelf(who), parsed.data.name);
        refresh();
        return { ok: true, folder };
    } catch (caught) {
        return failure(caught);
    }
}

const renameFolderInput = z.object({ folderId: id, name: core.automationFolderNameSchema });

export async function renameFolderAction(input: unknown): Promise<Result> {
    const parsed = renameFolderInput.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        await organize.renameFolder(await actor(), parsed.data.folderId, parsed.data.name);
        refresh();
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

export async function deleteFolderAction(folderId: unknown): Promise<Result> {
    const parsed = id.safeParse(folderId);
    if (!parsed.success) return invalid();
    try {
        await organize.deleteFolder(await actor(), parsed.data);
        refresh();
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

const moveInput = z.object({ automationId: id, folderId: id.nullable() });

export async function moveToFolderAction(input: unknown): Promise<Result> {
    const parsed = moveInput.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        await organize.moveToFolder(await actor(), parsed.data.automationId, parsed.data.folderId);
        refresh(parsed.data.automationId);
        return { ok: true };
    } catch (caught) {
        return failure(caught);
    }
}

const tagsInput = z.object({ automationId: id, tags: core.automationTagsSchema });

export async function setTagsAction(input: unknown): Promise<Result<{ tags: string[] }>> {
    const parsed = tagsInput.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        await organize.setTags(await actor(), parsed.data.automationId, parsed.data.tags);
        refresh(parsed.data.automationId);
        return { ok: true, tags: parsed.data.tags };
    } catch (caught) {
        return failure(caught);
    }
}

/**
 * The chat webhooks the signed-in account may post through from an automation:
 * those on the space channels it runs, as the channel's settings would let it
 * manage them.
 */
export async function chatWebhooksAction(): Promise<
    Result<{ webhooks: readonly ChatWebhookChoice[] }>
> {
    try {
        const who = await actor();
        const { webhooksToPostThrough } = await import("@/lib/chat/webhooks");
        return { ok: true, webhooks: await webhooksToPostThrough(who) };
    } catch (caught) {
        return failure(caught);
    }
}

/** What a threshold trigger can watch, for its picker: each kind's subjects and readings. */
export interface ThresholdKindChoice {
    readonly kind: string;
    readonly subjects: readonly { readonly id: string; readonly name: string }[];
    readonly sources: readonly { readonly id: string; readonly unit: string }[];
}

/**
 * The servers, services and UPS this account may watch. The same check runs
 * again on every evaluation against whoever the automation runs as.
 */
export async function thresholdChoicesAction(): Promise<
    Result<{ kinds: readonly ThresholdKindChoice[] }>
> {
    try {
        const who = await actor();
        const { thresholdKinds } = await import("@/lib/automations/threshold-sources");
        const kinds = await Promise.all(
            thresholdKinds().map(async (kind) => ({
                kind: kind.kind,
                subjects: await kind.subjects(who).catch(() => []),
                sources: kind.sources.map(({ id, unit }) => ({ id, unit }))
            }))
        );
        return { ok: true, kinds };
    } catch (caught) {
        return failure(caught);
    }
}

/** One of the account's own notification destinations, as a notice step lists it. */
export interface NoticeDestinationChoice {
    readonly id: string;
    readonly name: string;
    readonly targetHint: string;
    readonly enabled: boolean;
}

/**
 * Where a "tell somebody" step can deliver for the signed-in account: whether
 * this Polaris has an email channel to send from, the account's own
 * destinations, and the chat webhooks it may post through.
 */
export async function noticeChannelsAction(): Promise<
    Result<{
        mail: boolean;
        /** Whether this account may set up the email channel itself. */
        canSetUpMail: boolean;
        destinations: readonly NoticeDestinationChoice[];
        webhooks: readonly ChatWebhookChoice[];
        projectWebhooks: readonly ProjectWebhookChoice[];
        messagingChannels: readonly MessagingChannelChoice[];
    }>
> {
    try {
        const who = await actor();
        const [{ getAuthMailStatus }, { listDestinations }, { webhooksToPostThrough }, targets] =
            await Promise.all([
                import("@/lib/auth-mail"),
                import("@/lib/notifications/destinations"),
                import("@/lib/chat/webhooks"),
                import("@/lib/automations/notice-targets")
            ]);
        const [mail, destinations, webhooks, projectWebhooks, messagingChannels] =
            await Promise.all([
                getAuthMailStatus(),
                listDestinations(who.id),
                webhooksToPostThrough(who),
                targets.projectWebhooksToPostThrough(who.id),
                targets.messagingChannelsToPostThrough(who.id)
            ]);
        return {
            ok: true,
            mail: mail.channelId !== null,
            canSetUpMail: who.isAdmin,
            destinations: destinations.map((entry) => ({
                id: entry.id,
                name: entry.name,
                targetHint: entry.targetHint,
                enabled: entry.enabled
            })),
            webhooks,
            projectWebhooks,
            messagingChannels
        };
    } catch (caught) {
        return failure(caught);
    }
}
