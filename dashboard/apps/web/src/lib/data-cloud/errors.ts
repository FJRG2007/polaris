/**
 * Why a step against a cloud failed, as a key of the `deployServer` catalog
 * under `databases.cloud`: the action that shows it says it in the reader's
 * language, and nothing here is worded in English for them.
 */

/** Why a create in a cloud ended, as stored in `ManagedDatabase.providerError`. */
export const PROVISION_FAILURES = ["lost", "timeout", "keyRefused", "createRefused"] as const;
export type ProvisionFailure = (typeof PROVISION_FAILURES)[number];

/** A stored failure as one of the reasons the screen has words for. */
export function provisionFailure(stored: string | null): ProvisionFailure {
    return PROVISION_FAILURES.find((one) => one === stored) ?? "timeout";
}

export type CloudErrorKey =
    | "nothingAnswered"
    | "httpStatus"
    | "noResolve"
    | "privateAddress"
    | "keysRefused"
    | "keyRefused"
    | "userRefused"
    | "tokenRefused"
    | "noBucket"
    | "environmentNotFound"
    | "nameEmpty"
    | "nameTaken"
    | "notReady"
    | "amqpKeyRefused"
    | "amqpListFailed"
    | "amqpCreateFailed"
    | "amqpReadFailed"
    | "amqpDeleteFailed"
    | `failed.${ProvisionFailure}`;

export class CloudError extends Error {
    constructor(
        readonly key: CloudErrorKey,
        readonly params: Readonly<Record<string, string | number>> = {}
    ) {
        super(key);
        this.name = "CloudError";
    }
}
