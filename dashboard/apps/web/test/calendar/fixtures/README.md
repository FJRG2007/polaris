# Calendar fixtures

Files the engine tests read. Which ones were captured from a real producer and
which were written for these tests matters, so each is named here.

## Captured files (from ical.js)

Copied unmodified from the `samples/` directory of ical.js
(https://github.com/kewisch/ical.js, MPL-2.0, the licence of the dependency
itself). ical.js keeps them as real-world output its parser must handle.

| File here                       | ical.js sample           | Producer                                                                                         |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `icaljs-google-birthday.ics`    | `google_birthday.ics`    | Google Calendar export (`PRODID:-//Google Inc//Google Calendar 70.9054//EN`), birthdays calendar |
| `icaljs-daily-recur.ics`        | `daily_recur.ics`        | Google Calendar export, with EMAIL and DISPLAY alarms                                            |
| `icaljs-timezone-from-file.ics` | `timezone_from_file.ics` | Google Calendar PRODID with a VTIMEZONE (`Nowhere/Middle`) no time-zone database knows           |
| `icaljs-recur-instances.ics`    | `recur_instances.ics`    | Zimbra (`PRODID:Zimbra-Calendar-Provider`), with overrides, RDATE, a PERIOD RDATE and EXDATE     |

## Reconstructions (written for these tests)

No genuine iCloud, Nextcloud or Outlook export was available to copy: the
Nextcloud Calendar repository's own test files are AGPL-3.0 and are not copied
into this repository. These files were written by hand to reproduce
what those producers write - their PRODID, their `X-` properties and
parameters, their property order - and are **not captured files**. Addresses
and identifiers in them are placeholders.

| File                          | Reproduces                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `icloud-reconstructed.ics`    | iCloud / Apple Calendar: `X-APPLE-CALENDAR-COLOR`, `X-APPLE-STRUCTURED-LOCATION`, `X-WR-ALARMUID`, an `ACTION:NONE` default alarm, a managed attachment, a moved occurrence |
| `nextcloud-reconstructed.ics` | Nextcloud Calendar: its PRODID, a `BYSETPOS` monthly rule, attendees with `DELEGATED-FROM` and `LANGUAGE`, a cancelled occurrence, a VTODO                                  |
| `outlook-reconstructed.ics`   | Outlook: a Windows zone name as TZID (`Romance Standard Time`), `X-MICROSOFT-CDO-*` properties                                                                              |
