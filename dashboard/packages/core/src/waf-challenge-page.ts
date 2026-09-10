/**
 * The page a visitor gets while a service is asking for proof of a browser.
 *
 * It does the work itself: a small SHA-256 runs over the puzzle the guard issued until
 * it finds an answer with enough leading zero bits, writes the puzzle and the answer
 * into a cookie on the site's own domain, and reloads. Nothing is fetched from anywhere
 * - no captcha service, no script host - so the page works on a server with no
 * internet access and tells no third party who visited.
 *
 * The hash is written out here rather than taken from `crypto.subtle`, because the
 * browser only offers that on a secure page, and a service reached over plain HTTP
 * (a LAN name, a route behind a tunnel that ends TLS elsewhere) would otherwise be a
 * page that can never finish.
 */

import { edgePage, edgeText } from "./edge-page.js";

/**
 * A SHA-256 over an ASCII string, answering the eight 32-bit words of the digest.
 *
 * Exported as source so the tests can run exactly what the browser runs and compare it
 * with Node's own hash: the day these two disagree is the day every visitor is asked
 * forever and let through never.
 */
export const EDGE_SHA256_JS = "function sha256(s){var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];var l=s.length,w=[],i,j;for(i=0;i<l;i++)w[i>>2]|=(s.charCodeAt(i)&255)<<(24-(i%4)*8);w[l>>2]|=0x80<<(24-(l%4)*8);var n=((l+8)>>6)*16+16;for(i=0;i<n;i++)w[i]=w[i]|0;w[n-1]=l*8;var W=new Array(64);for(i=0;i<n;i+=16){var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];for(j=0;j<64;j++){if(j<16)W[j]=w[i+j];else{var x=W[j-15],y=W[j-2];W[j]=(((x>>>7)|(x<<25))^((x>>>18)|(x<<14))^(x>>>3))+W[j-16]+(((y>>>17)|(y<<15))^((y>>>19)|(y<<13))^(y>>>10))+W[j-7]|0;}var t1=h+(((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7)))+((e&f)^(~e&g))+K[j]+W[j]|0;var t2=(((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10)))+((a&b)^(a&c)^(b&c))|0;h=g;g=f;f=e;e=d+t1|0;d=c;c=b;b=a;a=t1+t2|0;}H[0]=H[0]+a|0;H[1]=H[1]+b|0;H[2]=H[2]+c|0;H[3]=H[3]+d|0;H[4]=H[4]+e|0;H[5]=H[5]+f|0;H[6]=H[6]+g|0;H[7]=H[7]+h|0;}return H;}";

/** What the page needs to solve and to keep the answer. */
export interface WafChallengePageInput {
    /** The signed puzzle, as the guard issued it. */
    readonly challenge: string;
    /** Leading zero bits the answer needs, 1 to 32. */
    readonly bits: number;
    /** The cookie the answer is kept in, and for how long. */
    readonly cookieName: string;
    readonly maxAge: number;
    /** Whether the page was served over https, so the cookie is marked Secure. */
    readonly secure: boolean;
    /** The nonce the response's CSP allows the script by. */
    readonly nonce: string;
    readonly host?: string;
    readonly ip?: string | null;
}

/** A value written into the script, with the one sequence that could end the script
 *  element made harmless. The puzzle is base64url and never contains it; this is for
 *  the day something else is passed through here. */
function scriptValue(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** An hourglass, as the contents of a stroked 24x24 viewBox. */
const HOURGLASS =
    '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"/><path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>';

/** Render the challenge page for one visitor. */
export function wafChallengePage(input: WafChallengePageInput): string {
    const bits = Math.min(32, Math.max(1, Math.round(input.bits)));
    const source = `(function(){${EDGE_SHA256_JS}var c=${scriptValue(input.challenge)},b=${bits},k=${scriptValue(input.cookieName)},m=${Math.max(1, Math.round(input.maxAge))},s=${input.secure ? "true" : "false"};var out=document.getElementById("polaris-status"),n=0;function ok(h){return b>=32?h[0]===0:(h[0]>>>(32-b))===0;}function done(x){document.cookie=k+"="+c+"."+x+"; Path=/; Max-Age="+m+"; SameSite=Lax"+(s?"; Secure":"");if(out)out.textContent="Done. Opening the site...";location.reload();}function step(){var end=n+4000;for(;n<end;n++){if(ok(sha256(c+":"+n))){done(n);return;}}setTimeout(step,0);}setTimeout(step,0);})();`;
    return edgePage({
        title: "Checking your browser",
        badge: "Checking",
        tone: "muted",
        icon: HOURGLASS,
        heading: "Checking your browser",
        lead: `${edgeText(input.host, "This site")} is taking extra care with its visitors right now. This takes a moment and happens once.`,
        sections: [
            {
                heading: "What is happening?",
                body: '<span id="polaris-status">Your browser is doing a short calculation that proves it is a browser. The site opens by itself when it is done.</span><noscript> Turn on JavaScript to continue.</noscript>'
            }
        ],
        facts: [{ label: "Your IP", value: edgeText(input.ip, "") }],
        note: "Protected by Polaris",
        script: { nonce: input.nonce, source }
    });
}
