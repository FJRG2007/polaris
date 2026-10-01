/**
 * The grid in the design system's tokens. FullCalendar ships its own sheet
 * (injected when it loads); these rules only re-point its variables at the
 * tokens and draw what the calendar adds: how the reader is taking part in an
 * event, what is past, what is a task.
 *
 * Scoped under `.pc-grid` so nothing leaks into the rest of the dashboard.
 */

export const GRID_CSS = `
.pc-grid .fc {
    --fc-border-color: hsl(var(--border));
    --fc-page-bg-color: hsl(var(--card));
    --fc-neutral-bg-color: hsl(var(--surface));
    --fc-neutral-text-color: hsl(var(--muted-foreground));
    --fc-today-bg-color: hsl(var(--muted) / 0.55);
    --fc-now-indicator-color: hsl(var(--danger));
    --fc-highlight-color: hsl(var(--primary) / 0.14);
    --fc-non-business-color: hsl(var(--background) / 0.45);
    --fc-list-event-hover-bg-color: hsl(var(--card-hover));
    --fc-event-border-color: transparent;
    --fc-small-font-size: 0.6875rem;
    font-size: 0.8125rem;
    color: hsl(var(--foreground));
    height: 100%;
}
.pc-grid .fc .fc-scrollgrid { border-color: hsl(var(--border)); }
.pc-grid .fc .fc-col-header-cell-cushion,
.pc-grid .fc .fc-daygrid-day-number,
.pc-grid .fc .fc-list-day-cushion { color: hsl(var(--muted-foreground)); text-decoration: none; font-weight: 500; }
.pc-grid .fc .fc-day-today .fc-daygrid-day-number,
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
.pc-grid .fc .fc-multimonth { border-color: hsl(var(--border)); }
.pc-grid .fc .fc-multimonth-title { font-size: 0.8125rem; font-weight: 600; }
.pc-grid .fc .fc-highlight { background: var(--fc-highlight-color); }

.pc-grid .fc .pc-past { opacity: 0.55; }
.pc-grid .fc .pc-cancelled .fc-event-title,
.pc-grid .fc .pc-cancelled .fc-list-event-title,
.pc-grid .fc .pc-declined .fc-event-title,
.pc-grid .fc .pc-declined .fc-list-event-title { text-decoration: line-through; }
.pc-grid .fc .pc-declined { opacity: 0.6; }
.pc-grid .fc .pc-needs-action { background-color: hsl(var(--card)) !important; border-style: dashed !important; border-width: 1px; border-color: inherit; }
.pc-grid .fc .pc-needs-action .fc-event-main,
.pc-grid .fc .pc-needs-action .fc-event-main-frame { color: hsl(var(--foreground)) !important; }
.pc-grid .fc .pc-tentative { background-image: repeating-linear-gradient(135deg, transparent 0 5px, rgb(255 255 255 / 0.22) 5px 10px); }
.pc-grid .fc .pc-busy { background-image: repeating-linear-gradient(45deg, transparent 0 4px, rgb(0 0 0 / 0.18) 4px 8px); }
.pc-grid .fc .pc-free { background-color: hsl(var(--card)) !important; border-width: 1px; }
.pc-grid .fc .pc-free .fc-event-main { color: hsl(var(--foreground)) !important; }
.pc-grid .fc .pc-task { border-style: solid; border-width: 1px; border-left-width: 3px; background-color: hsl(var(--card)) !important; }
.pc-grid .fc .pc-task .fc-event-main,
.pc-grid .fc .pc-task .fc-event-title { color: hsl(var(--foreground)) !important; }
.pc-grid .fc .pc-done .fc-event-title { text-decoration: line-through; color: hsl(var(--muted-foreground)) !important; }
.pc-grid .fc .pc-selected { box-shadow: 0 0 0 2px hsl(var(--foreground)); }

.pc-slot { display: inline-flex; gap: 0.5rem; }
.pc-slot-secondary { color: hsl(var(--subtle-foreground)); opacity: 0.8; }
`;
