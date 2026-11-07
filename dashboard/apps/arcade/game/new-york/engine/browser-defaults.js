// js/browser-defaults.js
// The browser's own reactions to a mouse or a finger that break a game: the context menu on a right click (the camera
// orbits with the mouse), autoscroll on a middle click, dragging the canvas or an image out as a file, selecting the
// HUD's text on a double click, and the long-press callout on touch. They stay where they mean something: in a text
// field (the map search) and in text the reader may want to copy.

const TEXT_FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Whether the browser's default for a pointer gesture on `target` should be kept: only in a field the reader types in. */
function keepsBrowserDefault(target) {
  const element = target && target.nodeType === 1 ? target : target?.parentElement;
  return Boolean(element && typeof element.closest === 'function' && element.closest(TEXT_FIELD));
}

/** Turns those defaults off for the whole page `doc`, once. */
function installBrowserGuards(doc = document) {
  const block = (e) => {
    if (!keepsBrowserDefault(e.target)) e.preventDefault();
  };
  doc.addEventListener('contextmenu', block);
  doc.addEventListener('dragstart', block);
  doc.addEventListener('selectstart', block);
  // Autoscroll starts on the middle button's mousedown (pointerdown cannot cancel it)
  doc.addEventListener('mousedown', (e) => {
    if (e.button === 1) block(e);
  });
  doc.addEventListener('auxclick', (e) => {
    if (e.button === 1) block(e);
  });
}

export { installBrowserGuards, keepsBrowserDefault };
