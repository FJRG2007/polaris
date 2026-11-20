/**
 * The site in the reader's language without being asked.
 *
 * English is the language every page falls back to, so it is the only one a
 * reader is moved away from: an English page opened by somebody whose browser
 * asks for Spanish first is replaced by the same page in Spanish, before it is
 * drawn. A Spanish address is always kept - somebody sent that link on purpose.
 * Once the reader picks a language in the picker, that choice is remembered and
 * nothing is detected again.
 *
 * Static export, so it is a script that runs first in the body. Built from
 * constants only (the base path and the page's language), never from the
 * address.
 */

import type { SiteLocale } from "@/data/builders";

/** Where the picker remembers the reader's choice. */
export const LOCALE_CHOICE_KEY = "polaris-site-locale";

/** The language a browser asks for first, among the site's, or null. */
export function preferredLocale(languages: readonly string[]): SiteLocale | null {
    for (const language of languages) {
        const base = language.toLowerCase().split("-")[0];
        if (base === "es" || base === "en") return base;
    }
    return null;
}

export function localeScript(basePath: string, pageLocale: SiteLocale): string {
    if (pageLocale !== "en") return "";
    return `(function(){try{var b=${JSON.stringify(basePath)},k=${JSON.stringify(LOCALE_CHOICE_KEY)},c=null;try{c=localStorage.getItem(k)}catch(e){}var w=c;if(!w){var l=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""];for(var i=0;i<l.length;i++){var s=String(l[i]).toLowerCase().split("-")[0];if(s==="es"||s==="en"){w=s;break}}}if(w!=="es")return;var p=location.pathname;if(b&&p.indexOf(b)===0)p=p.slice(b.length);var r=p.replace(/^\\/+/,"").split("/");if(r[0]==="en")r.shift();location.replace(b+"/es/"+r.join("/")+location.search+location.hash)}catch(e){}})();`;
}
