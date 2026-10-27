/** Types for `address.mjs`, which ships as plain JavaScript in the responder image. */

export interface InterfaceAddress {
    readonly address: string;
    readonly family: string | number;
    readonly internal: boolean;
}

export function defaultRouteInterfaces(routeTable: string | null | undefined): string[];

export function lanAddresses(
    interfaces:
        Readonly<Record<string, readonly InterfaceAddress[] | undefined>> | null | undefined,
    routeTable: string | null | undefined
): string[];

export function defaultRouteInterfaces6(routeTable: string | null | undefined): string[];

export function globalIpv6(
    addressTable: string | null | undefined,
    routeTable: string | null | undefined
): string | null;

export function defaultGateway(routeTable: string | null | undefined): string | null;

export const NAT_PMP_REQUEST: Uint8Array;

export function natPmpExternal(message: Uint8Array | readonly number[] | null | undefined): string | null;
