# Ids in Capstan projects

Every item in a project has an id that is assigned when the item is created and never changes. Other Fleet apps that need to point at something in a Capstan project (a clip, a marker, a caption) use these ids.

## Shape

`<prefix>_<time><counter><random>`, for example `clp_mvw4k2a1x9q3zp`. The time is the creation time in base 36, the counter and six random characters make two ids made in the same millisecond differ. Ids are plain strings of letters, digits, `_` and `-`.

| Prefix | What it names |
| --- | --- |
| `prj` | A project |
| `trk` | A track |
| `med` | A media item in the bin (the same media can be on the timeline many times) |
| `clp` | A clip on the timeline |
| `ann` | An annotation (text, shape, arrow and so on) |
| `red` | A blur or pixelate region |
| `zom` | A zoom-n-pan region |
| `mrk` | A marker (a chapter when flagged) |
| `cap` | A caption |
| `grp` | A group of clips |
| `lnk` | A link between a video clip and the audio detached from it |
| `tpl` | A saved template |

## Rules

- An id is unique inside one project. Across projects it is unique in practice (the time and random parts), and Capstan does not check.
- `parseProject` keeps every id it is given; it makes one only when an id is missing, and replaces a repeated id in annotations and markers (see [PROJECT-FILE.md](PROJECT-FILE.md)).
- Saving, opening, `.capstan` and `.capstanz` files, undo and redo, and the browser store all keep ids.
- Duplicating or pasting a clip gives the copy a new id. Splitting a clip keeps the id on the left part and gives the right part a new one.
- Ids are never reused after an item is deleted within a session, and Capstan never renumbers.

## Pointing at an item from another app

Default (decided here, not yet used by any other app): a reference is the pair of the project id and the item id, written `capstan:<projectId>:<itemId>`, for example `capstan:prj_mvw1x2:mrk_mvw4k2a1x9q3zp`. The project id is in `project.json` as `id`. A reference is valid only for the project file it came from; if the project is duplicated, the copy keeps the item ids but has a new project id.

A change to this scheme is a breaking change for the apps that store references: add prefixes, do not rename them.
