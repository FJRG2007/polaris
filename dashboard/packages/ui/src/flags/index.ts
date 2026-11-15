/**
 * Country and region flags, vendored from flag-icons 7.6.0
 * (https://github.com/lipis/flag-icons, MIT - see ./LICENSE): only the ones a
 * language picker can show. Each is its own module, loaded the first time a
 * flag is drawn, so a page that never opens a language picker never fetches
 * them and nothing is fetched from anywhere but the app itself.
 */

export const FLAG_LOADERS: Readonly<Record<string, () => Promise<{ default: string }>>> = {
    br: () => import("./svg/br"),
    bg: () => import("./svg/bg"),
    cn: () => import("./svg/cn"),
    cz: () => import("./svg/cz"),
    de: () => import("./svg/de"),
    dk: () => import("./svg/dk"),
    ee: () => import("./svg/ee"),
    es: () => import("./svg/es"),
    "es-ct": () => import("./svg/es-ct"),
    "es-ga": () => import("./svg/es-ga"),
    "es-pv": () => import("./svg/es-pv"),
    fi: () => import("./svg/fi"),
    fr: () => import("./svg/fr"),
    gb: () => import("./svg/gb"),
    gr: () => import("./svg/gr"),
    hu: () => import("./svg/hu"),
    id: () => import("./svg/id"),
    il: () => import("./svg/il"),
    in: () => import("./svg/in"),
    it: () => import("./svg/it"),
    jp: () => import("./svg/jp"),
    kr: () => import("./svg/kr"),
    lt: () => import("./svg/lt"),
    lv: () => import("./svg/lv"),
    nl: () => import("./svg/nl"),
    no: () => import("./svg/no"),
    pl: () => import("./svg/pl"),
    pt: () => import("./svg/pt"),
    ro: () => import("./svg/ro"),
    ru: () => import("./svg/ru"),
    sa: () => import("./svg/sa"),
    se: () => import("./svg/se"),
    si: () => import("./svg/si"),
    sk: () => import("./svg/sk"),
    th: () => import("./svg/th"),
    tr: () => import("./svg/tr"),
    tw: () => import("./svg/tw"),
    ua: () => import("./svg/ua"),
    us: () => import("./svg/us"),
    vn: () => import("./svg/vn")
};
