/**
 * The grid in the design system's tokens. FullCalendar ships its own sheet
 * (injected when it loads); these rules only re-point its variables at the
 * tokens and draw what the calendar adds: how the reader is taking part in an
 * event, what is past, what is a task, and where today and now are.
 *
 * An event's colours are its own inline style (`grid-events.ts` picks them, with
 * the ink checked for contrast); the rules here only say how a state is drawn -
 * outlined, striped, struck through - never which colour.
 *
 * Scoped under `.pc-grid` so nothing leaks into the rest of the dashboard.
 */

export const GRID_CSS = `
.pc-grid .fc {
    --fc-border-color: hsl(var(--border));
    --fc-page-bg-color: hsl(var(--card));
    --fc-neutral-bg-color: hsl(var(--surface));
    --fc-neutral-text-color: hsl(var(--muted-foreground));
    --fc-today-bg-color: transparent;
    --fc-now-indicator-color: hsl(var(--danger-solid));
    --fc-highlight-color: hsl(var(--primary) / 0.14);
    --fc-non-business-color: hsl(var(--background) / 0.45);
    --fc-list-event-hover-bg-color: hsl(var(--card-hover));
    --fc-small-font-size: 0.6875rem;
    font-size: 0.8125rem;
    color: hsl(var(--foreground));
    height: 100%;
}
.pc-grid .fc .fc-scrollgrid { border-color: hsl(var(--border)); }
.pc-grid .fc .fc-col-header-cell-cushion,
.pc-grid .fc .fc-daygrid-day-number,
.pc-grid .fc .fc-list-day-cushion { color: hsl(var(--muted-foreground)); text-decoration: none; font-weight: 500; }
.pc-grid .fc .fc-day-today .fc-col-header-cell-cushion { color: hsl(var(--foreground)); font-weight: 600; }
.pc-grid .fc .fc-timegrid-slot-label,
.pc-grid .fc .fc-timegrid-axis,
.pc-grid .fc .fc-event-time,
.pc-grid .fc .fc-list-event-time,
.pc-grid .fc .fc-daygrid-day-number,
.pc-grid .fc .fc-col-header-cell-cushion,
.pc-grid .fc .fc-daygrid-week-number,
.pc-grid .fc .fc-timegrid-axis-cushion { font-variant-numeric: tabular-nums; }
.pc-grid .fc .fc-timegrid-slot-label-cushion,
.pc-grid .fc .fc-timegrid-axis-cushion { color: hsl(var(--subtle-foreground)); font-size: 0.6875rem; }
.pc-grid .fc .fc-timegrid-slot { height: 1.75rem; }
.pc-grid .fc .fc-daygrid-week-number,
.pc-grid .fc .fc-timegrid-axis .fc-week-number { background: transparent; color: hsl(var(--subtle-foreground)); }
.pc-grid .fc a.fc-daygrid-more-link { color: hsl(var(--muted-foreground)); }
.pc-grid .fc .fc-popover { background: hsl(var(--elevated)); border-color: hsl(var(--border-strong)); border-radius: 0.5rem; box-shadow: var(--shadow-popover, 0 8px 24px rgb(0 0 0 / 0.35)); }
.pc-grid .fc .fc-popover-header { background: transparent; color: hsl(var(--muted-foreground)); }
.pc-grid .fc .fc-event { border-radius: 4px; font-size: 0.75rem; cursor: pointer; }
.pc-grid .fc .fc-event:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 1px; }
.pc-grid .fc .fc-daygrid-dot-event .fc-event-title { font-weight: 500; }
.pc-grid .fc .fc-list { border-color: hsl(var(--border)); }
.pc-grid .fc .fc-list-empty { background: transparent; color: hsl(var(--muted-foreground)); }
/* The month's weeks are all one height (month-rows.ts): a day's events are laid
   over its cell instead of sizing the week, and every week is at least as high
   as the busiest day needs. */
.pc-grid .fc .fc-dayGridMonth-view .fc-daygrid-day-events { position: absolute; left: 0; right: 0; min-height: 0; }
.pc-grid .fc .fc-dayGridMonth-view .fc-daygrid-body tbody > tr { height: var(--pc-week-min, auto); }
.pc-grid .fc .fc-multimonth { border-color: hsl(var(--border)); }
.pc-grid .fc .fc-multimonth-title { font-size: 0.8125rem; font-weight: 600; }
.pc-grid .fc .fc-highlight { background: var(--fc-highlight-color); }

/* Events: filled, with the state drawn by edge, stripes and lines. */
.pc-grid .fc .fc-h-event,
.pc-grid .fc .fc-v-event { border-width: 1px; }
/* Room inside the colored box: FullCalendar's own 1px left the text against
   its left edge. A bar in the month grid or the all-day row, and a block in a
   day or a week, both keep the text 6px in, and the time apart from the title. */
.pc-grid .fc .fc-daygrid-block-event .fc-event-main { padding: 1px 6px; }
.pc-grid .fc .fc-daygrid-block-event .fc-event-time,
.pc-grid .fc .fc-daygrid-block-event .fc-event-title { padding: 1px 0; }
.pc-grid .fc .fc-daygrid-block-event .fc-event-main-frame { gap: 4px; }
.pc-grid .fc .fc-timegrid-event .fc-event-main { padding: 2px 6px; }
/* A block too short for two lines (15 or 30 minutes) puts the time and the
   title on one line; its room is on the sides only, so the line is not cut.
   The title comes first, as in Google, so a narrow column still names it. */
.pc-grid .fc .fc-timegrid-event-short .fc-event-main { padding: 0 6px; }
.pc-grid .fc .fc-timegrid-event-short .fc-event-main-frame { align-items: center; gap: 4px; line-height: 1.15; }
.pc-grid .fc .fc-timegrid-event-short .fc-event-title-container { order: -1; flex: 0 1 auto; min-width: 0; }
.pc-grid .fc .fc-timegrid-event-short .fc-event-title { white-space: nowrap; text-overflow: ellipsis; }
.pc-grid .fc .fc-timegrid-event-short .fc-event-time { flex: 0 1000 auto; min-width: 0; text-overflow: ellipsis; opacity: 0.85; }
.pc-grid .fc .fc-timegrid-event-short .fc-event-time::after { content: none; }
.pc-grid .fc .fc-timegrid-event .fc-event-title { font-weight: 500; }
.pc-grid .fc .fc-v-event.pc-accepted,
.pc-grid .fc .fc-v-event.pc-task { box-shadow: 0 0 0 1px hsl(var(--card)); }
.pc-grid .fc .fc-v-event.pc-needs-action,
.pc-grid .fc .fc-h-event.pc-needs-action,
.pc-grid .fc .fc-v-event.pc-tentative,
.pc-grid .fc .fc-h-event.pc-tentative { border-width: 1.5px; }
.pc-grid .fc .fc-v-event.pc-tentative,
.pc-grid .fc .fc-h-event.pc-tentative { border-style: dashed; }
.pc-grid .fc .fc-v-event.pc-striped,
.pc-grid .fc .fc-h-event.pc-striped { background-image: repeating-linear-gradient(135deg, transparent 0 5px, var(--pc-stripe, transparent) 5px 10px); }
/* A timed event in the month grid is a dot, the time and the title (Google's
   rule); an unanswered or tentative one has a ring for a dot. */
.pc-grid .fc .fc-daygrid-dot-event.pc-needs-action .fc-daygrid-event-dot,
.pc-grid .fc .fc-daygrid-dot-event.pc-tentative .fc-daygrid-event-dot { width: 8px; height: 8px; border-width: 2px; box-sizing: border-box; flex-shrink: 0; }
.pc-grid .fc .pc-cancelled .fc-event-title,
.pc-grid .fc .pc-cancelled .fc-list-event-title,
.pc-grid .fc .pc-declined .fc-event-title,
.pc-grid .fc .pc-declined .fc-list-event-title,
.pc-grid .fc .pc-done .fc-event-title { text-decoration: line-through; }
.pc-grid .fc .fc-daygrid-dot-event.pc-past .fc-event-title,
.pc-grid .fc .fc-daygrid-dot-event.pc-past .fc-event-time,
.pc-grid .fc .fc-list-event.pc-past { color: hsl(var(--muted-foreground)); }
.pc-grid .fc .fc-event.pc-selected { box-shadow: 0 0 0 2px hsl(var(--card)), 0 0 0 4px hsl(var(--foreground)); z-index: 6; }
.pc-grid .fc .fc-event-dragging,
.pc-grid .fc .fc-event-resizing,
.pc-grid .fc .fc-event-mirror { box-shadow: var(--shadow-popover); opacity: 0.92; }

/* Today: the date in a filled circle, wherever a day is named. */
.pc-dh { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 0 6px; line-height: 1; }
.pc-dh-weekday { font-size: 0.6875rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
.pc-dh-number { display: inline-flex; align-items: center; justify-content: center; min-width: 2rem; height: 2rem; padding: 0 0.25rem; border-radius: 999px; font-size: 1.25rem; font-weight: 500; color: hsl(var(--foreground)); }
.pc-grid .fc .fc-day-today .pc-dh-weekday { color: hsl(var(--primary)); }
.pc-grid .fc .fc-day-today .pc-dh-number,
.pc-grid .fc .fc-day-today .pc-day-number { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); font-weight: 600; }
.pc-grid .fc .fc-day-past .pc-dh-number,
.pc-grid .fc .fc-day-past .pc-dh-weekday { color: hsl(var(--subtle-foreground)); }
.pc-grid .fc .fc-daygrid-day-top { justify-content: center; }
.pc-grid .fc .fc-daygrid-day-number { padding: 4px 2px 2px; }
.pc-day-number { display: inline-flex; align-items: center; justify-content: center; min-width: 1.5rem; height: 1.5rem; padding: 0 0.375rem; border-radius: 999px; white-space: nowrap; }
.pc-grid .fc .fc-day-other .pc-day-number { color: hsl(var(--subtle-foreground)); }
.pc-grid .fc .fc-multimonth .fc-daygrid-day-top { justify-content: center; }

/* Weekends, a shade off the week. */
.pc-grid .fc .fc-timegrid-col.pc-weekend,
.pc-grid .fc .fc-daygrid-day.pc-weekend,
.pc-grid .fc .fc-col-header-cell.pc-weekend { background-color: hsl(var(--muted) / 0.4); }

/* What is past: days before today, and today until now. */
.pc-dim-past .fc .fc-timegrid-col.fc-day-past,
.pc-dim-past .fc .fc-daygrid-day.fc-day-past:not(.fc-day-other) { background-image: linear-gradient(hsl(var(--background) / 0.42), hsl(var(--background) / 0.42)); }
.pc-dim-past .fc .fc-daygrid-day.fc-day-past .pc-day-number { color: hsl(var(--subtle-foreground)); }
.pc-grid .fc .fc-bg-event.pc-elapsed { background: hsl(var(--background)); opacity: 0.42; }

/* The display zone, in the time grid's top-left corner. */
.pc-grid .fc .fc-col-header .fc-timegrid-axis-frame[data-zone]:empty::after { content: attr(data-zone); display: block; width: 100%; padding: 0 4px 6px; align-self: flex-end; text-align: right; font-size: 0.625rem; color: hsl(var(--subtle-foreground)); white-space: nowrap; }

/* Now: a red line across today with a dot where it starts, and the time on the axis. */
.pc-grid .fc .fc-timegrid-now-indicator-line { border-top-width: 2px; }
.pc-grid .fc .fc-timegrid-now-indicator-line::before { content: ""; position: absolute; left: 0; top: -6px; width: 10px; height: 10px; border-radius: 999px; background: var(--fc-now-indicator-color); }
.pc-grid .fc .fc-timegrid-now-indicator-arrow { border: 0; left: auto; right: 2px; margin-top: -0.5rem; }
.pc-now-time { display: inline-block; padding: 1px 4px; border-radius: 4px; background: hsl(var(--danger-solid)); color: hsl(var(--danger-foreground)); font-size: 0.625rem; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }

.pc-slot { display: inline-flex; gap: 0.5rem; }
.pc-slot-secondary { color: hsl(var(--subtle-foreground)); opacity: 0.8; }
`;
