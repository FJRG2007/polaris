-- A calendar pull matches each remote object by its address in the calendar
-- before its uid; that lookup was a sequential scan of the table per object.
CREATE INDEX IF NOT EXISTS "CalendarObject_calendarId_href_idx" ON "CalendarObject"("calendarId", "href");
