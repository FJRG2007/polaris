# Places: bringing the surveillance stack up to what the field expects

What Places did was a ladder: the camera reported movement, or Polaris diffed
postage-stamp frames against the frame before, and anything past that was handed
to a face service and asked "can you see a face" as a stand-in for "is that a
person". It was cheap and it worked, and it was also the reason a camera pointed
at a road could not be told to ignore the road, an event could not say *where* in
the picture something was, and one person walking past a door produced a row a
second rather than one row.

Three projects have solved this already. What each was worth taking from:

| Source | What it does better |
| --- | --- |
| **Frigate** | Real object detection over a small model, with score / area / aspect-ratio filters per class. Object **tracking**, so a walk-past is one event with a start and an end rather than forty. **Best-snapshot** selection, so the picture kept is the frame where you can actually see them. **Zones** as relative-coordinate polygons with their own object filters, an inertia count and a loitering timer. Motion masks. A motion detector that compares against a running average with contrast normalization, and hands back contours rather than a percentage. |
| **ZoneMinder** | Zone *kinds*: an area that triggers, and an area that is ignored outright - the answer to a tree that moves on every windy afternoon. |
| **Shinobi** | The region editor: polygons drawn straight onto a live frame in the browser, which is the only way this is ever going to be configured by somebody who is not reading a YAML reference. |

## What was built

1. **Zone geometry** (`@polaris/core/camera-zones`) - relative polygons,
   point-in-polygon, the ground point of a box, overlap, area and ratio, and the
   inertia / loitering state machine. Pure, so the editor, the server and the
   worker all decide "inside" the same way.
2. **The zone editor** - an outline traced over the camera's own live frame,
   with the areas already drawn visible underneath. Each carries what it is for,
   which classes count in it, how settled something has to be, and how long it
   has to stay.
3. **Real object detection** - YOLOX tiny in the vision worker, Apache-2.0 like
   Polaris, baked into the image and pinned by checksum. The decode, the overlap
   suppression, the class folding and the per-class filters are pure and pinned
   against a real run of the model.
4. **Tracking and the best frame** - one arrival is one event, and the picture
   kept is the frame the detector liked best, cropped out of that exact frame.
   A better frame later improves the event rather than opening another.
5. **A better motion detector** - a running average of the scene, contrast
   stretched against a rolling estimate, blurred, and answering with outlines
   rather than a percentage. Ignored areas are masked out of the pixels before
   anything is compared.
6. **Events that say where** - the box and the areas are stored on the event and
   drawn over the still, the list can be narrowed to one area, and an event has
   a length rather than only an instant.
7. **Alerts that know about areas** - "a person in the driveway", not "a person",
   and the message leads with the area rather than the camera.

## What was deliberately not built

- **A pre-roll buffer.** ZoneMinder keeps the seconds before an event, and
  `recording.ts` already explains why Places does not: it would mean holding
  every camera's stream in memory all day, which is the exact cost this app
  exists to avoid. A house that wants the seconds before an event records
  continuously, and an event already resolves to the segment containing it.
- **A second container.** Detection runs in the vision worker that already
  exists. Places asks the operator to install two things; a third would be a
  third thing to keep up to date.
- **A configuration file.** Frigate's expressiveness lives in YAML its users
  read a reference for. Everything here is a row and a screen, per this repo's
  first constraint.
- **Speed estimation, license plates, and generated descriptions.** All three
  are real features in Frigate and none of them was what was missing here.

## What has not been exercised

The model was run on this machine and its decoder pinned against the reference
implementation, so the arithmetic is known-good. The worker itself has not run:
this machine has no Docker, so the image has never been built, ffprobe has never
been asked about a real camera, and nothing has been watched end to end.
