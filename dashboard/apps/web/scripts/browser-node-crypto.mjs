// What a browser bundle gets for `node:crypto`. The post-quantum key exchange
// the chat encryption uses (mlkem) only asks for Node's module when the global
// Web Crypto is missing, which never happens in a tab; webpack still has to
// resolve the specifier, and cannot read a `node:` URL for the browser.
export const webcrypto = globalThis.crypto;
export default { webcrypto };
