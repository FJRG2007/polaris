"use server";

/**
 * Everything the VPN screens ask for and change.
 *
 * Signed-in people manage their own devices; turning the control server on or
 * off, removing it, and approving what a device offers are an administrator's
 * (`lib/vpn/settings.ts` holds the rules, and the service checks them again).
 * Every input is validated here against a schema before it reaches the
 * service, and a refusal comes back as a sentence in the reader's language.
 */

import { z } from "zod";
import * as vpn from "@/lib/vpn/service";
import { revalidatePath } from "next/cache";
import * as rules from "@/lib/vpn/settings";
import { findApp } from "@/lib/apps/catalog";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { installApp } from "@/lib/apps/install-service";
import { requireAdmin, requireUser } from "@/lib/session";
import { defaultInstallInput } from "@/lib/apps/install-defaults";

type Result<T = object> = { error: string } | ({ error?: undefined } & T);

/** The sentence a failure is shown as. Only refusals written for a reader are
 *  passed on; anything else is logged and said generically. */
async function failed(error: unknown): Promise<{ error: string }> {
    const t = await getTranslations("vpn");
    if (error instanceof vpn.VpnRefusal) return { error: t(`errors.${error.code}`) };
    if (error instanceof z.ZodError) return { error: t("errors.invalid") };
    console.error("polaris: VPN action failed:", error);
    return { error: t("errors.generic") };
}

function refresh(): void {
    revalidatePath("/apps/vpn", "layout");
}

function viewerOf(user: { id: string; isAdmin: boolean }): rules.VpnViewer {
    return { id: user.id, isAdmin: user.isAdmin };
}

const nodeIdSchema = z
    .string()
    .trim()
    .regex(/^\d{1,20}$/);
const hostnameChoiceSchema = z.object({
    zoneLabel: z.string().trim().max(253).optional(),
    subdomain: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)?$/)
});

/** Install the app from its own screen. Runs nothing: the control server starts
 *  only when an administrator turns it on. */
export async function installVpnAppAction(): Promise<Result> {
    const user = await requireAdmin();
    try {
        const manifest = findApp(rules.VPN_APP);
        if (!manifest) return failed(new vpn.VpnRefusal("notInstalled"));
        const { installedAppId } = await installApp(
            user.id,
            user.id,
            defaultInstallInput(manifest)
        );
        await recordAudit({
            actorId: user.id,
            action: "apps.install",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath("/", "layout");
        revalidatePath("/apps/marketplace");
        revalidatePath("/admin/apps");
        return {};
    } catch (error) {
        return failed(error);
    }
}

export interface VpnOverview {
    readonly status: vpn.VpnStatus;
    /** The zones a hostname may be taken in; empty for anybody but an
     *  administrator, who is the only one who can pick. */
    readonly zones: { label: string; host: string; primary: boolean }[];
}

/** Where the control server stands, asked after the first paint. */
export async function vpnOverviewAction(): Promise<Result<VpnOverview>> {
    const user = await requireUser();
    try {
        const [status, zones] = await Promise.all([
            vpn.vpnStatus(),
            rules.mayOperate(viewerOf(user)) ? vpn.hostnameZones() : Promise.resolve([])
        ]);
        return { status, zones };
    } catch (error) {
        return failed(error);
    }
}

/** Whether a hostname is free, as the administrator types it. */
export async function checkVpnHostnameAction(
    input: unknown
): Promise<Result<{ hostname: string; available: boolean; invalid: boolean }>> {
    const user = await requireAdmin();
    const parsed = hostnameChoiceSchema.safeParse(input);
    if (!parsed.success) return { hostname: "", available: false, invalid: true };
    try {
        const result = await vpn.checkHostname(user.id, parsed.data);
        if (typeof result === "string") {
            const t = await getTranslations("vpn");
            return { error: t(`zoneErrors.${result}`) };
        }
        return {
            hostname: result.hostname,
            available: result.available,
            invalid: result.invalid === true
        };
    } catch (error) {
        return failed(error);
    }
}

export async function turnOnVpnAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    try {
        const choice = hostnameChoiceSchema.parse(input);
        await vpn.turnOn(user.id, choice);
        await recordAudit({
            actorId: user.id,
            action: "vpn.on",
            targetType: "installedApp",
            targetId: rules.VPN_APP
        });
        refresh();
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function turnOffVpnAction(): Promise<Result> {
    const user = await requireAdmin();
    try {
        await vpn.turnOff();
        await recordAudit({
            actorId: user.id,
            action: "vpn.off",
            targetType: "installedApp",
            targetId: rules.VPN_APP
        });
        refresh();
        return {};
    } catch (error) {
        return failed(error);
    }
}

/** Delete the control server and every device on it. */
export async function removeVpnAction(): Promise<Result> {
    const user = await requireAdmin();
    try {
        await vpn.removeVpn();
        await recordAudit({
            actorId: user.id,
            action: "vpn.remove",
            targetType: "installedApp",
            targetId: rules.VPN_APP
        });
        refresh();
        return {};
    } catch (error) {
        return failed(error);
    }
}

/** The devices the reader may see: all of them for an administrator. */
export async function listVpnDevicesAction(): Promise<Result<{ devices: vpn.VpnDevice[] }>> {
    const user = await requireUser();
    try {
        return { devices: await vpn.listDevices(viewerOf(user)) };
    } catch (error) {
        return failed(error);
    }
}

export async function renameVpnDeviceAction(
    input: unknown
): Promise<Result<{ device: vpn.VpnDevice }>> {
    const user = await requireUser();
    try {
        const { nodeId, name } = z.object({ nodeId: nodeIdSchema, name: z.string() }).parse(input);
        return { device: await vpn.renameDevice(viewerOf(user), nodeId, name) };
    } catch (error) {
        return failed(error);
    }
}

export async function removeVpnDeviceAction(input: unknown): Promise<Result> {
    const user = await requireUser();
    try {
        const { nodeId } = z.object({ nodeId: nodeIdSchema }).parse(input);
        await vpn.removeDevice(viewerOf(user), nodeId);
        await recordAudit({
            actorId: user.id,
            action: "vpn.device.remove",
            targetType: "vpnDevice",
            targetId: nodeId
        });
        return {};
    } catch (error) {
        return failed(error);
    }
}

const routeSchema = z
    .string()
    .trim()
    .max(64)
    .regex(/^[0-9a-fA-F:.]+\/\d{1,3}$/);

export async function setVpnDeviceRoutesAction(
    input: unknown
): Promise<Result<{ device: vpn.VpnDevice }>> {
    const user = await requireUser();
    try {
        const { nodeId, exitNode, routes } = z
            .object({
                nodeId: nodeIdSchema,
                exitNode: z.boolean(),
                routes: z.array(routeSchema).max(64)
            })
            .parse(input);
        const device = await vpn.setDeviceRoutes(viewerOf(user), nodeId, { exitNode, routes });
        await recordAudit({
            actorId: user.id,
            action: "vpn.device.routes",
            targetType: "vpnDevice",
            targetId: nodeId
        });
        return { device };
    } catch (error) {
        return failed(error);
    }
}

/** A one-time key for a device that cannot open a browser to sign in. */
export async function createVpnKeyAction(): Promise<Result<{ key: string; expiresAt: string }>> {
    const user = await requireUser();
    try {
        return await vpn.createDeviceKey({ id: user.id, name: user.name, email: user.email });
    } catch (error) {
        return failed(error);
    }
}

/** Add the device waiting at `authId` to the reader's devices. */
export async function registerVpnDeviceAction(
    input: unknown
): Promise<Result<{ device: vpn.VpnDevice }>> {
    const user = await requireUser();
    try {
        const { authId } = z.object({ authId: rules.authIdSchema }).parse(input);
        const device = await vpn.registerDevice(
            { id: user.id, name: user.name, email: user.email },
            authId
        );
        await recordAudit({
            actorId: user.id,
            action: "vpn.device.add",
            targetType: "vpnDevice",
            targetId: device.id
        });
        return { device };
    } catch (error) {
        return failed(error);
    }
}
