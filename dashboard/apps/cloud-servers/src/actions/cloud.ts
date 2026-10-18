"use server";

/** Everything the Cloud servers screen asks of the server. Each input is
 *  validated here before anything reads it. */

import { z } from "zod";
import * as service from "../lib/service";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { machineNameSchema, PROVIDERS } from "../lib/providers/types";

const id = z.string().uuid();
const providerToken = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_./:-]+$/);

export type Overview = Awaited<ReturnType<typeof service.listServers>> & {
    accounts: service.AccountView[];
};

export async function overviewAction(): Promise<Outcome<Overview>> {
    return outcome(async () => {
        const user = await service.requireCloudUser();
        const [accounts, servers] = await Promise.all([
            service.listAccounts(user.id),
            service.listServers(user.id)
        ]);
        return { accounts, ...servers };
    });
}

const accountSchema = z.object({
    provider: z.enum(PROVIDERS),
    name: z.string().trim().min(1).max(60),
    credentials: z.record(z.string().max(12_000)).refine((r) => Object.keys(r).length <= 8),
    // The organization it is connected for; absent or null for the person's own.
    orgId: id.nullable().optional()
});

export async function connectAccountAction(
    input: unknown
): Promise<Outcome<{ account: service.AccountView }>> {
    const parsed = accountSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const user = await service.requireCloudUser();
        const { orgId, ...account } = parsed.data;
        return { account: await service.addAccount(user.id, account, orgId ?? null) };
    });
}

export async function removeAccountAction(accountId: unknown): Promise<Outcome<object>> {
    const parsed = id.safeParse(accountId);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const user = await service.requireCloudUser();
        await service.removeAccount(user.id, parsed.data);
        return {};
    });
}

const optionsSchema = z.object({ accountId: id, region: providerToken.nullable() });

export async function optionsAction(
    input: unknown
): Promise<Outcome<Awaited<ReturnType<typeof service.accountOptions>>>> {
    const parsed = optionsSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const user = await service.requireCloudUser();
        return service.accountOptions(user.id, parsed.data.accountId, parsed.data.region);
    });
}

export const createSchema = z.object({
    accountId: id,
    name: machineNameSchema,
    region: providerToken,
    size: providerToken,
    image: providerToken
});

export async function createServerAction(
    input: unknown
): Promise<Outcome<{ server: service.ServerView }>> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const user = await service.requireCloudUser();
        return { server: await service.createServer(user.id, parsed.data) };
    });
}

export async function progressAction(
    serverId: unknown
): Promise<Outcome<{ server: service.ServerView }>> {
    const parsed = id.safeParse(serverId);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const user = await service.requireCloudUser();
        return { server: await service.serverProgress(user.id, parsed.data) };
    });
}

const powerSchema = z.object({ serverId: id, action: z.enum(["power_on", "power_off", "reboot"]) });

export async function powerAction(input: unknown): Promise<Outcome<object>> {
    const parsed = powerSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const user = await service.requireCloudUser();
        await service.powerServer(user.id, parsed.data.serverId, parsed.data.action);
        return {};
    });
}

const resizeSchema = z.object({ serverId: id, size: providerToken });

export async function resizeAction(input: unknown): Promise<Outcome<object>> {
    const parsed = resizeSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const user = await service.requireCloudUser();
        await service.resizeServer(user.id, parsed.data.serverId, parsed.data.size);
        return {};
    });
}

const destroySchema = z.object({ serverId: id, typedName: z.string().trim().min(1).max(60) });

export async function destroyAction(input: unknown): Promise<Outcome<object>> {
    const parsed = destroySchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const user = await service.requireCloudUser();
        await service.destroyServer(user.id, parsed.data.serverId, parsed.data.typedName);
        return {};
    });
}
