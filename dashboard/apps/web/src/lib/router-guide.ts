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

/** A value the fixed-address form asks for, and where that value comes from. */
export interface RouterReserveField {
    /** What this brand's form calls it. */
    readonly label: string;
    readonly value: "name" | "mac" | "ip";
}

/**
 * How a brand pins this server to one address. Two shapes, because routers split
 * evenly between them: a table you add an entry to, and a device list where the
 * lease already there is made permanent. Telling an operator to "reserve it in the
 * DHCP settings" is only useful for the first kind, and only if they find the tab -
 * on ZTE the LAN page has three, and the reservation is not on the one named DHCP.
 */
export type RouterReservation =
    | {
          readonly kind: "form";
          readonly path: string;
          /** The control that starts a new entry. */
          readonly add: string;
          readonly fields: readonly RouterReserveField[];
          /** The control that commits it. */
          readonly save: string;
      }
    | {
          readonly kind: "device";
          readonly path: string;
          /** What to do to this server's entry once found, in the router's words. */
          readonly action: string;
      };

export interface RouterBrandGuide {
    readonly id: RouterBrand;
    readonly label: string;
    /** The name its admin page answers on, when it has one besides the gateway IP. */
    readonly admin: string | null;
    /** The factory sign-in, as far as one brand-wide answer exists. */
    readonly signIn: string;
    /** Where and how to give this server a fixed address. */
    readonly reserve: RouterReservation;
    /** Menu path to the port-forwarding form. */
    readonly forwardPath: string;
    /** The fields that form asks for, when this brand names them its own way. */
    readonly forwardFields: readonly RouterFormField[] | null;
    /** The control that commits a rule, when the brand names it something particular. */
    readonly forwardSave: string | null;
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

/**
 * What a forwarding form asks for. Generic labels cover most brands, but some name
 * the same five things differently enough that an operator cannot map one to the
 * other - ZTE asks for a "LAN Host" and two port RANGES, and there is no row called
 * "internal port" anywhere on the page.
 */
export type RouterForwardValue =
    /** The rule's name. */
    | "name"
    /** TCP. */
    | "protocol"
    /** The port, once. */
    | "port"
    /** The port as a range, for forms whose port fields are `from ~ to`. */
    | "portRange"
    /** This server's LAN address. */
    | "ip"
    /** "any source", for forms that ask which WAN addresses the rule accepts. */
    | "anySource";

export interface RouterFormField {
    readonly label: string;
    readonly value: RouterForwardValue;
}

export const ROUTER_BRANDS: readonly RouterBrandGuide[] = [
    {
        id: "zte",
        label: "ZTE",
        admin: null,
        signIn: "The user and password printed on the label underneath the router. On an ISP box the user is usually `admin` and the password is the one on the label, not the WiFi key.",
        reserve: {
            kind: "form",
            // Not the DHCP Server tab, which is where the name sends everyone first:
            // that one sets the pool. The binding tab is the one that pins an address.
            path: "Local Network > LAN > DHCP Binding",
            add: "New Item",
            fields: [
                { label: "Name", value: "name" },
                { label: "MAC Address", value: "mac" },
                { label: "IP Address", value: "ip" }
            ],
            save: "Create New Item"
        },
        forwardPath: "Internet > Security > Port Forwarding",
        // Verbatim from the H3640 form, in its order. None of the labels match the
        // generic ones: the destination is "LAN Host", both port fields are ranges,
        // and there is a WAN source range that has to be left wide open.
        forwardFields: [
            { label: "Name", value: "name" },
            { label: "Protocol", value: "protocol" },
            { label: "WAN Host IP Address", value: "anySource" },
            { label: "LAN Host", value: "ip" },
            { label: "WAN Port", value: "portRange" },
            { label: "LAN Host Port", value: "portRange" }
        ],
        forwardSave: "Create New Item",
        remotePath: "Management & Diagnosis > Remote management (some builds keep it under Internet > Security > Access control)",
        caution:
            "ZTE firmware supplied by an ISP reserves 80, 443, 21 and 7547 for its own management and refuses to forward them. If the form rejects the rule, the ports cannot be opened on this router - publish Polaris through a tunnel instead, under Advanced below."
    },
    {
        id: "huawei",
        label: "Huawei",
        admin: "http://192.168.100.1",
        signIn: "The user and password on the label. ISP units keep port forwarding behind an installer account the label does not carry - ask your provider for it if the menu is missing.",
        reserve: {
            kind: "form",
            path: "LAN > DHCP Static IP Configuration",
            add: "New",
            fields: [
                { label: "MAC Address", value: "mac" },
                { label: "IP Address", value: "ip" }
            ],
            save: "Apply"
        },
        forwardPath: "Forward Rules > Port Mapping Configuration, with Type set to Custom",
        forwardFields: null,
        forwardSave: null,
        remotePath: "Security > ACL Rules, which is what usually publishes the admin page on the WAN side",
        caution: null
    },
    {
        id: "tplink",
        label: "TP-Link",
        admin: "http://tplinkwifi.net",
        signIn: "The account you created on first setup. A router never set up asks for `admin` / `admin`.",
        reserve: {
            kind: "form",
            path: "Advanced > Network > DHCP Server > Address Reservation",
            add: "Add",
            fields: [
                { label: "MAC Address", value: "mac" },
                { label: "IP Address", value: "ip" },
                { label: "Description", value: "name" }
            ],
            save: "Save"
        },
        forwardPath: "Advanced > NAT Forwarding > Virtual Servers > Add",
        forwardFields: null,
        forwardSave: null,
        remotePath: "Advanced > System Tools > Administration > Remote Management",
        caution: null
    },
    {
        id: "asus",
        label: "ASUS",
        admin: "http://router.asus.com",
        signIn: "The account you created on first setup, or `admin` / `admin` on one never set up.",
        reserve: {
            kind: "form",
            path: "LAN > DHCP Server, with Enable Manual Assignment set to Yes",
            add: "the + button under Manually Assigned IP around the DHCP list",
            fields: [
                { label: "MAC Address", value: "mac" },
                { label: "IP Address", value: "ip" },
                { label: "Name (optional)", value: "name" }
            ],
            save: "Apply"
        },
        forwardPath: "WAN > Virtual Server / Port Forwarding, with Enable Port Forwarding set to Yes",
        forwardFields: null,
        forwardSave: null,
        remotePath: "Administration > System > Enable Web Access from WAN",
        caution: null
    },
    {
        id: "fritzbox",
        label: "FRITZ!Box",
        admin: "http://fritz.box",
        signIn: "The FRITZ!Box password on the label or on the card that came with it. There is no user name.",
        reserve: {
            kind: "device",
            path: "Home Network > Network > Network Connections",
            action: 'open this server with the pencil button and tick "Always assign this network device the same IPv4 address"'
        },
        forwardPath: "Internet > Permit Access > Port Sharing > Add Device for Sharing",
        forwardFields: null,
        forwardSave: null,
        remotePath: "Internet > Permit Access > FRITZ!Box Services",
        caution:
            "It shares ports per device: pick this server, then add one sharing for 80 and one for 443. Turn on the advanced view if the menu is not there."
    },
    {
        id: "netgear",
        label: "NETGEAR",
        admin: "http://routerlogin.net",
        signIn: "`admin` with the password you set. A router never set up uses `admin` / `password`.",
        reserve: {
            kind: "form",
            path: "ADVANCED > Setup > LAN Setup > Address Reservation",
            add: "Add",
            fields: [
                { label: "IP Address", value: "ip" },
                { label: "MAC Address", value: "mac" },
                { label: "Device Name", value: "name" }
            ],
            save: "Add"
        },
        forwardPath: "ADVANCED > Advanced Setup > Port Forwarding / Port Triggering > Add Custom Service",
        forwardFields: null,
        forwardSave: null,
        remotePath: "ADVANCED > Advanced Setup > Remote Management",
        caution: null
    },
    {
        id: "mikrotik",
        label: "MikroTik",
        admin: "http://192.168.88.1",
        signIn: "`admin`, with no password on a router still at defaults.",
        reserve: {
            kind: "device",
            path: "IP > DHCP Server > Leases",
            action: 'select the lease showing this server and press "Make Static"'
        },
        forwardPath: "IP > Firewall > NAT > Add, chain dstnat",
        forwardFields: null,
        forwardSave: null,
        remotePath: "IP > Services, where the www and www-ssl services hold 80 and 443",
        caution:
            "The form is not a port-forward form: set chain=dstnat, protocol=tcp, dst-port=80,443, in-interface to the WAN interface, then action=dst-nat with to-addresses set to this server."
    },
    {
        id: "other",
        label: "Another brand",
        admin: null,
        signIn: "The user and password on the label underneath the router - on most boxes this is not the WiFi password. If it was changed and is lost, a factory reset is the only way back in.",
        reserve: {
            kind: "form",
            path: "the DHCP or LAN settings, under a name like Address Reservation, DHCP Binding or Static Lease",
            add: "the button that adds an entry",
            fields: [
                { label: "MAC address", value: "mac" },
                { label: "IP address", value: "ip" }
            ],
            save: "Save"
        },
        forwardPath:
            "Look for Port forwarding, Virtual server, NAT/PAT or Applications & Gaming - the same form under four different names.",
        forwardFields: null,
        forwardSave: null,
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
 * The rules a game server needs on top of those.
 *
 * 80 and 443 carry every website Polaris serves and not one game client: a game
 * server answers on its own port, on its own transport, and a Bedrock rule
 * forwarded as TCP forwards nothing at all. Named after the server so an operator
 * looking at a list of rules a year from now can tell which one it belongs to, and
 * so deleting the server tells them which rule to take out.
 */
export function gameForwardRules(
    servers: readonly { name: string; ports: readonly { port: number; protocol: "tcp" | "udp" }[] }[]
): RouterForwardRule[] {
    const rules: RouterForwardRule[] = [];
    for (const server of servers) {
        const slug = server.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
        for (const port of server.ports) {
            rules.push({ name: `game-${slug}-${port.port}`, protocol: port.protocol.toUpperCase(), port: port.port });
        }
    }
    return rules;
}

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
