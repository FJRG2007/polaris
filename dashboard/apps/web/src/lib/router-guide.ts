/**
 * What to do inside the router, spelled out per brand.
 *
 * Telling an operator to "forward 80 and 443" is only useful to someone who has done
 * it before: the menu is named differently on every box, the sign-in is rarely the
 * WiFi password, and the form asks for five values that have to be exactly right.
 * So the advice carries the address of the admin page, where to sign in, the menu
 * path, and the values to type - and the ones Polaris knows (its own LAN address,
 * the ports) are filled in rather than described.
 *
 * Pure: the domains panel renders it, and it is shared with the notification copy.
 * What is not verifiable from here is worded as such - the gateway is inferred from
 * this server's own address, and the sign-in on an ISP-supplied box is whatever the
 * ISP set, which is why the label on the router is always the first answer.
 */

export type RouterBrand =
    | "zte"
    | "huawei"
    | "tplink"
    | "asus"
    | "fritzbox"
    | "netgear"
    | "mikrotik"
    | "other";

export interface RouterBrandGuide {
    readonly id: RouterBrand;
    readonly label: string;
    /** The name its admin page answers on, when it has one besides the gateway IP. */
    readonly admin: string | null;
    /** The factory sign-in, as far as one brand-wide answer exists. */
    readonly signIn: string;
    /** Menu path to the port-forwarding form. */
    readonly forwardPath: string;
    /** Menu path to whatever is holding 80 and 443, when the brand has a usual one. */
    readonly remotePath: string | null;
    /** What is different about this brand, in the operator's way. */
    readonly caution: string | null;
}

/** One rule to create. Both are the same shape; only the port differs. */
export interface RouterForwardRule {
    readonly name: string;
    readonly protocol: string;
    readonly port: number;
}

export const ROUTER_BRANDS: readonly RouterBrandGuide[] = [
    {
        id: "zte",
        label: "ZTE",
        admin: null,
        signIn: "The user and password printed on the label underneath the router. On an ISP box the user is usually `admin` and the password is the one on the label, not the WiFi key.",
        forwardPath: "Internet > Security > Port Forwarding (in Spanish: Internet > Seguridad > Reenvio de puertos)",
        remotePath: "Management & Diagnosis > Remote management (some builds keep it under Internet > Security > Access control)",
        caution:
            "ZTE firmware supplied by an ISP reserves 80, 443, 21 and 7547 for its own management and refuses to forward them. If the form rejects the rule, the ports cannot be opened on this router - publish Polaris through a tunnel instead, under Advanced below."
    },
    {
        id: "huawei",
        label: "Huawei",
        admin: "http://192.168.100.1",
        signIn: "The user and password on the label. ISP units keep port forwarding behind an installer account the label does not carry - ask your provider for it if the menu is missing.",
        forwardPath: "Forward Rules > Port Mapping Configuration, with Type set to Custom",
        remotePath: "Security > ACL Rules, which is what usually publishes the admin page on the WAN side",
        caution: null
    },
    {
        id: "tplink",
        label: "TP-Link",
        admin: "http://tplinkwifi.net",
        signIn: "The account you created on first setup. A router never set up asks for `admin` / `admin`.",
        forwardPath: "Advanced > NAT Forwarding > Virtual Servers > Add",
        remotePath: "Advanced > System Tools > Administration > Remote Management",
        caution: null
    },
    {
        id: "asus",
        label: "ASUS",
        admin: "http://router.asus.com",
        signIn: "The account you created on first setup, or `admin` / `admin` on one never set up.",
        forwardPath: "WAN > Virtual Server / Port Forwarding, with Enable Port Forwarding set to Yes",
        remotePath: "Administration > System > Enable Web Access from WAN",
        caution: null
    },
    {
        id: "fritzbox",
        label: "FRITZ!Box",
        admin: "http://fritz.box",
        signIn: "The FRITZ!Box password on the label or on the card that came with it. There is no user name.",
        forwardPath: "Internet > Permit Access > Port Sharing > Add Device for Sharing",
        remotePath: "Internet > Permit Access > FRITZ!Box Services",
        caution:
            "It shares ports per device: pick this server, then add one sharing for 80 and one for 443. Turn on the advanced view if the menu is not there."
    },
    {
        id: "netgear",
        label: "NETGEAR",
        admin: "http://routerlogin.net",
        signIn: "`admin` with the password you set. A router never set up uses `admin` / `password`.",
        forwardPath: "ADVANCED > Advanced Setup > Port Forwarding / Port Triggering > Add Custom Service",
        remotePath: "ADVANCED > Advanced Setup > Remote Management",
        caution: null
    },
    {
        id: "mikrotik",
        label: "MikroTik",
        admin: "http://192.168.88.1",
        signIn: "`admin`, with no password on a router still at defaults.",
        forwardPath: "IP > Firewall > NAT > Add, chain dstnat",
        remotePath: "IP > Services, where the www and www-ssl services hold 80 and 443",
        caution:
            "The form is not a port-forward form: set chain=dstnat, protocol=tcp, dst-port=80,443, in-interface to the WAN interface, then action=dst-nat with to-addresses set to this server."
    },
    {
        id: "other",
        label: "Another brand",
        admin: null,
        signIn: "The user and password on the label underneath the router - on most boxes this is not the WiFi password. If it was changed and is lost, a factory reset is the only way back in.",
        forwardPath:
            "Look for Port forwarding, Virtual server, NAT/PAT or Applications & Gaming - the same form under four different names.",
        remotePath: "Look for Remote management, Web access from WAN or Remote administration.",
        caution: null
    }
];

/** Fallback for anything not in the list, so a lookup always returns a guide. */
const GENERIC = ROUTER_BRANDS[ROUTER_BRANDS.length - 1]!;

export function routerGuide(brand: RouterBrand): RouterBrandGuide {
    return ROUTER_BRANDS.find((entry) => entry.id === brand) ?? GENERIC;
}

/** Substrings that identify a brand in a `Server` header, most specific first. */
const SIGNATURES: readonly (readonly [RouterBrand, readonly string[]])[] = [
    ["zte", ["zte"]],
    ["huawei", ["huawei", "echolife"]],
    ["tplink", ["tp-link", "tplink"]],
    ["asus", ["asus"]],
    ["fritzbox", ["fritz"]],
    ["netgear", ["netgear"]],
    ["mikrotik", ["mikrotik", "routeros"]]
];

/**
 * Which brand answered, read from the `Server` header of whatever replied instead
 * of Polaris. Router firmware names itself there far more often than not, and it
 * costs the operator nothing when it does not - the panel starts on the brand this
 * finds and stays a picker either way.
 */
export function detectRouterBrand(server: string | null): RouterBrand {
    if (!server) return "other";
    const haystack = server.toLowerCase();
    for (const [brand, needles] of SIGNATURES) {
        if (needles.some((needle) => haystack.includes(needle))) return brand;
    }
    return "other";
}

/** The two rules Polaris needs, named so they are recognizable a year later. */
export const FORWARD_RULES: readonly RouterForwardRule[] = [
    { name: "polaris-http", protocol: "TCP", port: 80 },
    { name: "polaris-https", protocol: "TCP", port: 443 }
];

/**
 * The router's own address, inferred from this server's. Routers sit on .1 of the
 * subnet nearly always, and "nearly" is why this is offered as a starting point
 * rather than stated - the address that is certain is the one already in the
 * browser's network settings as the gateway.
 */
export function likelyGateway(lanIp: string | null): string | null {
    if (!lanIp) return null;
    const parts = lanIp.split(".");
    if (parts.length !== 4) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}
