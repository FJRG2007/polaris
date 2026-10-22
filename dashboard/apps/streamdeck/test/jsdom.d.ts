// jsdom ships no types and the plugin compiles without the DOM library, so the
// settings-screen test reaches the page through an untyped window.
declare module "jsdom";
