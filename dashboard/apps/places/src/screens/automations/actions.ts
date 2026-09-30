"use server";

/**
 * Everything the automation screens call.
 *
 * Reading them is `home.read`, as reading the devices is. Writing one, switching
 * it, running it and removing it is `home.manage`: an automation is a standing
 * instruction to operate the house with nobody at the button, which is the same
 * kind of decision as connecting the account the doors are on - and somebody
 * lent one door holds neither. One that operates a device also needs the saver
 * to hold `home.control`, because it will act with their rights.
 *
 * Failures come back as `{ error }`, and a definition the schema refuses comes
 * back as `{ issues }` with where each one belongs, so the editor can put it
 * under the field rather than above the form.
 */

import { randomUUID } from "node:crypto";
import { host } from "@polaris/app-host";
import { placesT } from "../../lib/i18n";
import * as devices from "../../lib/devices";
import { requireHome } from "../../lib/access";
import { guard } from "../../lib/action-guard";
import * as auto from "../../lib/automation-kinds";
import * as automations from "../../lib/automations";
import { currentPlace } from "../../lib/current-place";
import { autoOffName, issueText } from "../../lib/automation-words";
import type { DeviceView } from "../../lib/device-kinds";

const { recordAudit } = host.auditService;
const { sessionCan } = host.session;

/** A complaint about one field, already in the reader's words. */
export interface AutomationFieldIssue {
    readonly path: readonly (string | number)[];
    readonly message: string;
}

/** The automations of the place being looked at, and the devices they name. */
export async function listAutomationsAction(): Promise<{
    automations?: auto.AutomationView[];
    devices?: DeviceView[];
    placeId?: string;
    error?: string;
}> {
    const { install } = await requireHome("home.read");
    const result = await guard(async () => {
        const { current } = await currentPlace(install.id);
        const [list, found] = await Promise.all([
            automations.listAutomations(install.id, current.id),
            devices.listDevices(install.id, current.id)
        ]);
        return { list, found, placeId: current.id };
    });
    if (result.error) return { error: result.error };
    return {
        automations: result.value?.list,
        devices: result.value?.found,
        placeId: result.value?.placeId
    };
}

/** What the editor draws its pickers from, for one place: the devices there and
 *  the other automations a step can start. */
export interface EditorContext {
    readonly placeId: string;
    readonly devices: DeviceView[];
    readonly siblings: { readonly id: string; readonly name: string }[];
}

async function editorContext(installedAppId: string, placeId: string): Promise<EditorContext> {
    const [found, list] = await Promise.all([
        devices.listDevices(installedAppId, placeId),
        automations.listAutomations(installedAppId, placeId)
    ]);
    return {
        placeId,
        devices: found,
        siblings: list.map((automation) => ({ id: automation.id, name: automation.name }))
    };
}

/** One automation with what its editor needs: its log, the devices its pickers
 *  offer and the automations a step can start. A null id is a new one, at the
 *  place being looked at. */
export async function getAutomationAction(id: string | null): Promise<{
    automation?: auto.AutomationView;
    runs?: auto.RunView[];
    context?: EditorContext;
    error?: string;
}> {
    const { install } = await requireHome("home.read");
    const result = await guard(async () => {
        if (!id) {
            const { current } = await currentPlace(install.id);
            return { automation: undefined, runs: [], context: await editorContext(install.id, current.id) };
        }
        const automation = await automations.getAutomation(install.id, String(id));
        const [runs, context] = await Promise.all([
            automations.listRuns(install.id, automation.id),
            editorContext(install.id, automation.placeId)
        ]);
        return { automation, runs, context };
    });
    if (result.error) return { error: result.error };
    return { automation: result.value?.automation, runs: result.value?.runs, context: result.value?.context };
}

/** What an automation has done lately, newest first. */
export async function automationRunsAction(id: string): Promise<{ runs?: auto.RunView[]; error?: string }> {
    const { install } = await requireHome("home.read");
    const result = await guard(() => automations.listRuns(install.id, String(id)));
    return result.error ? { error: result.error } : { runs: result.value };
}

/**
 * Save an automation, new (`id` null) or changed.
 *
 * Normalized and checked with the editor's own schema, then against the devices
 * the place actually has - a device removed while the editor was open is caught
 * here and said under its field.
 */
export async function saveAutomationAction(
    id: string | null,
    input: unknown
): Promise<{ automation?: auto.AutomationView; issues?: AutomationFieldIssue[]; error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const t = await placesT();
    const parsed = auto.automationInputSchema.safeParse(auto.normalizeAutomationInput(input));
    if (!parsed.success) {
        return {
            issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issueText(issue.message, t) })),
            error: t("automations.errors.fix")
        };
    }
    if (auto.actsOnDevices(parsed.data.definition) && !(await sessionCan(user, "home.control"))) {
        return { error: t("automations.errors.noControl") };
    }
    const self = id ? String(id) : null;
    const checked = await guard(() => automations.checkAutomation(install.id, parsed.data, self));
    if (checked.error) return { error: checked.error };
    if (checked.value && checked.value.length > 0) {
        return {
            issues: checked.value.map((issue) => ({ path: issue.path, message: issueText(issue.message, t) })),
            error: t("automations.errors.fix")
        };
    }
    const result = await guard(() => automations.saveAutomation(install.id, user.id, self, parsed.data));
    if (result.error) return { error: result.error };
    await recordAudit({
        actorId: user.id,
        action: self ? "places.automation.update" : "places.automation.create",
        targetType: "placeAutomation",
        targetId: result.value?.id ?? "",
        metadata: { name: parsed.data.name }
    });
    return { automation: result.value };
}

export async function setAutomationEnabledAction(
    id: string,
    enabled: boolean
): Promise<{ automation?: auto.AutomationView; error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const result = await guard(() => automations.setAutomationEnabled(install.id, String(id), enabled === true));
    if (result.error) return { error: result.error };
    await recordAudit({
        actorId: user.id,
        action: enabled === true ? "places.automation.enable" : "places.automation.disable",
        targetType: "placeAutomation",
        targetId: String(id)
    });
    return { automation: result.value };
}

export async function deleteAutomationAction(id: string): Promise<{ error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const result = await guard(() => automations.deleteAutomation(install.id, String(id)));
    if (result.error) return { error: result.error };
    await recordAudit({
        actorId: user.id,
        action: "places.automation.delete",
        targetType: "placeAutomation",
        targetId: String(id)
    });
    return {};
}

/** Run it now. The run is queued and started; the screen reads the log again
 *  rather than waiting on the steps. */
export async function runAutomationAction(id: string): Promise<{ error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const result = await guard(() => automations.runAutomationNow(install.id, String(id), user.name, randomUUID()));
    if (result.error) return { error: result.error };
    await recordAudit({
        actorId: user.id,
        action: "places.automation.run",
        targetType: "placeAutomation",
        targetId: String(id)
    });
    return {};
}

/**
 * "Turn off after this many minutes on", from a device's own panel, in one press.
 *
 * The automation is written and switched on as it would be from the editor, by
 * the same checks, so opening it afterwards shows exactly what was made.
 */
export async function addAutoOffAction(
    deviceId: string,
    minutes: number,
    timeZone: string
): Promise<{ automation?: auto.AutomationView; issues?: AutomationFieldIssue[]; error?: string }> {
    const { install } = await requireHome("home.manage");
    const t = await placesT();
    const found = await guard(async () => {
        const device = await devices.getDevice(install.id, String(deviceId));
        const { current } = await currentPlace(install.id);
        return { device, placeId: device.placeId ?? current.id };
    });
    if (found.error || !found.value) return { error: found.error ?? t("refusals.failed") };
    const { device, placeId } = found.value;
    const definition = auto.autoOffDefinition(device, Number(minutes), String(timeZone));
    if (!definition) return { error: t("automations.errors.noAutoOff") };
    return saveAutomationAction(null, {
        name: autoOffName(device, Number(minutes), t),
        enabled: true,
        placeId,
        definition
    });
}
