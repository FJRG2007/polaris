# Places: bringing the surveillance stack up to what the field expects

What Places does today is a ladder: the camera reports movement, or Polaris
diffs postage-stamp frames, and anything past that is handed to a face service
that is asked "can you see a face" as a stand-in for "is that a person". It is
cheap and it works, and it is also the reason a camera pointed at a road cannot
be told to ignore the road, an event cannot say *where* in the picture something
was, and one person walking past a door produces a row a second rather than one
row.

Three projects have solved this already. What each is worth taking from:

| Source | What it does better |
| --- | --- |
| **Frigate** | Real object detection over a small model, with score / area / aspect-ratio filters per class. Object **tracking**, so a walk-past is one event with a start and an end rather than forty. **Best-snapshot** selection, so the picture kept is the frame where you can actually see them. **Zones** as relative-coordinate polygons with their own object filters, an inertia count and a loitering timer. Motion masks. A motion detector that compares against a running average with contrast normalization, and hands back contours rather than a percentage. |
| **ZoneMinder** | Zone *kinds*: an area that triggers, an area that is ignored outright, and a preclusive area whose alarm cancels the whole event (the answer to a tree that moves on every windy afternoon). Pre- and post-event buffers, so the clip starts before the thing that triggered it. An alarm frame count before an event opens. |
| **Shinobi** | The region editor: polygons drawn straight onto a live frame in the browser, which is the only way this is ever going to be configured by somebody who is not reading a YAML reference. |

## The order of work

Each step ships on its own and is committed as it lands.

1. **Zone geometry** - one pure module: relative polygons, point-in-polygon,
   the ground point of a box, IoU, area and ratio filters, and the inertia /
   loitering state machine. Unit-tested with no camera and no container.
   A `CameraZone` table and its migration.
2. **The zone editor** - draw a polygon over the camera's own live frame,
   pick what it is for and which things count in it.
3. **Real object detection** - a small ONNX model in the vision worker,
   COCO classes folded into the four a house has an opinion about, with
   Frigate's filters. This replaces "ask the face service if it sees a face".
4. **Tracking and the best frame** - a centroid tracker so one thing that
   happened is one event, and the still kept is the best frame of it.
5. **A better motion detector** - running average, contrast normalization,
   blur and contours, masked by the ignore zones, producing boxes rather
   than a single percentage.
6. **Events that say where** - boxes and zones stored on the event, drawn
   over the still, filterable in the list.
7. **Recording that starts before the event** - a pre-roll buffer, so the
   clip opens seconds before the trigger rather than after it.
8. **Alerts that know about zones** - "a person in the driveway", not
   "a person".

## What does not get taken

- **No new container.** Detection runs in the vision worker that already
  exists. A second service is a second thing to install, and Places already
  asks for two.
- **No configuration file.** Frigate's expressiveness lives in a YAML file
  its users read a reference for. Everything here is a row and a screen,
  per the repo's first constraint.
- **No speed estimation, no license plates, no GenAI descriptions.** All
  three are real features in Frigate and none of them is what is missing here.
