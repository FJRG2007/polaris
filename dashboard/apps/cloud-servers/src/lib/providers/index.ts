/**
 * An adapter for one account, loading only that provider's module.
 *
 * Each provider is a dynamic import, so a Polaris with only a Hetzner account
 * never evaluates the AWS signer or the Azure client.
 */

import { credentialSchemas, type ProviderAdapter, type ProviderId } from "./types";

type Factory = (credentials: never) => ProviderAdapter;

const LOADERS: Readonly<Record<ProviderId, () => Promise<{ createAdapter: Factory }>>> = {
    digitalocean: () => import("./digitalocean"),
    hetzner: () => import("./hetzner"),
    vultr: () => import("./vultr"),
    linode: () => import("./linode"),
    aws: () => import("./aws"),
    azure: () => import("./azure"),
    gcp: () => import("./gcp"),
    ionos: () => import("./ionos")
};

/** Build the adapter from a stored credential (JSON), validated again on read. */
export async function adapterFor(
    provider: ProviderId,
    credentialJson: string
): Promise<ProviderAdapter> {
    const credentials = credentialSchemas[provider].parse(JSON.parse(credentialJson));
    const { createAdapter } = await LOADERS[provider]();
    return createAdapter(credentials as never);
}
