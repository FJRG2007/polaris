# Places wall panels

A wall panel is shown full screen on a tablet fixed to a wall. It is used
standing, with one finger, for a second at a time. These are the patterns the
panel follows, and where they come from.

## Patterns adopted

- **One press per card, the rest behind a tap.** A device card shows its name,
  its state in large type, a reading as a big number, and one big button for
  what it is mostly used for (lock or unlock, open, on or off, clean). Modes,
  fan speed, targets, timers and settings open in a full-screen sheet with the
  devices screen's own controls. A card never scrolls.
  Source: Home Assistant tile card and its more-info dialog
  (https://home-assistant.io/dashboards/cards/); Bubble Card's pop-ups
  (https://community.home-assistant.io/t/bubble-card-a-minimalist-card-collection-for-home-assistant-with-a-nice-pop-up-touch/609678);
  Google Home Favorites, where a tap is the quick control and touch-and-hold
  opens every control (https://support.google.com/googlehome/answer/14887882).
- **A short status, not sentences.** The state line is one phrase ("Not
  answering", "Cooling", "Locked"), never an explanation.
  Source: Mushroom cards' primary/secondary info lines
  (https://community.home-assistant.io/t/mushroom-cards-build-a-beautiful-dashboard-easily-part-2/693055).
- **The screen decides the grid.** Cells are never smaller than the panel's card
  size; the number of columns and rows comes from the screen's width and height,
  so portrait and landscape tablets each get a grid that fits. Cards keep their
  arranged order and span by kind and by the size they were given in Arrange.
  Rows are evened out with the Overview's own packing (`packOverviewSpans`).
  Source: Home Assistant sections view and its grid
  (https://www.home-assistant.io/dashboards/sections/,
  https://www.home-assistant.io/blog/2024/03/04/dashboard-chapter-1/).
- **Pages, not shrinking.** When a screen cannot hold every card at touch size,
  the rest go on the next page, reached by a swipe or 56px page buttons.
  Source: Google Pixel Tablet home panel
  (https://support.google.com/googlepixeltablet/answer/13555147).
- **Scale per panel.** Each panel sets its text size (90-150%), its card size
  and its orientation (turn with the tablet, or locked landscape/portrait, drawn
  turned when the tablet is held the other way). Users scaling a whole dashboard
  up for a wall tablet is a long-standing request
  (https://community.home-assistant.io/t/can-i-scale-the-whole-dashboard-up-when-i-view-it-on-a-tablet/563293).
- **Kiosk behaviour.** Nothing around the cards, a screen that stays on, a
  screensaver, dark at night. Source: Fully Kiosk Browser setups with Home
  Assistant kiosk mode (https://www.home-assistant.io/dashboards/views/).
- **Touch targets.** Every control on a card is at least 56px; the primary
  button is 64px tall.

## Where it lives

- `apps/places/src/lib/panel-fit.ts` - the grid for a screen (`fitPanel`), the
  card's one press (`primaryAction`) and its big reading (`wallReading`).
- `apps/places/src/screens/panels/panel-fit-grid.tsx` - measures the box, lays
  the cards out, pages them.
- `apps/places/src/screens/panels/panel-cards.tsx` and `panel-wall-sheet.tsx` -
  the cards and the full-screen sheet.
- `apps/web/test/places/panels/panel-no-scroll.test.ts` - no card may scroll or
  use small text.
