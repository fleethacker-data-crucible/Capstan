# The .capstan project file

A `.capstan` file is the editing project as JSON text (UTF-8): tracks, clips, media entries, annotations, zooms, captions, markers, redactions, cursor settings and the in and out marks. It holds the edit only. A media entry is metadata (name, kind, size, duration, optional cursor data); the media bytes are not in it. To move a project with its media to another computer, use a `.capstanz` package (see [ARCHITECTURE.md](ARCHITECTURE.md), "Storage").

The format is described by a published JSON Schema, draft 2020-12:

- [project.schema.json](project.schema.json), `$id` `https://github.com/fleethacker-data-crucible/Capstan/docs/project.schema.json`.

The schema describes the normalised form `parseProject` (`src/engine/project.ts`) returns and the editor saves. Each object also says what `parseProject` does with a field the schema does not list (`x-extra-fields`): media entries and a clip's `props` keep extra fields, everything else drops them. An extra field never makes a file invalid.

## Version rule

- `version` is `1`, and the schema holds it as a constant. A file with any other version is refused.
- A breaking change to the format bumps `version` and keeps a migration in `parseProject`, so a file saved by an older Capstan still opens. A change that only adds an optional field does not bump it.
- Ids are plain strings and stay stable: `parseProject` keeps every id it is given. It makes one only when an id is missing, and it replaces a repeated id in annotations and markers.

## Required and optional

- `parseProject` needs only `version`, `tracks`, `clips` and `media`. It fills in everything else, which is how projects saved before redactions, captions, annotations, zooms or markers existed still open. A saved file always has all the lists, and the schema requires them.
- Optional in the file: `cursorFx` and `range` (only when set), a track's `magnetic`, a media item's `thumb` and `cursor`, and on a clip `speed`, `freeze`, `crop`, `keys`, `behavior`, `effects`, `audio`, `transitionIn`, `transitionOut`, `linkId`, `groupId`, `audioOnly` and `muteAudio`. A flag that is off, a speed of 1 and a fade of 0 are left out rather than stored.
- On an annotation `keys` and `behavior` are optional; on a cursor effect `image` is.

## Checking a file

`parseProject` is the loader and repairs what it can: numbers are clamped into range, a text that is too long is cut, a clip whose track or media does not exist is dropped. The schema is stricter. It rejects a file that the loader would silently change, such as a width outside 16 to 7680 or a clip duration that is text.

Some rules cannot be written in a schema and are listed in the schema's descriptions: a clip's `trackId` and `mediaId` must name a track and a media item in the same file; blur regions and zoom rectangles must lie inside the canvas, and annotation boxes within a few canvas widths of it, which depends on `width` and `height`; a caption's `end` is after its `start`; captions and markers are sorted; a crop stays inside the frame.

`tests/unit/project-schema.test.ts` validates projects built with the editor's operations, the output of `parseProject` for messy older files, and a set of deliberately broken ones, with a small validator in `tests/unit/helpers/json-schema.ts` (no dependency). The schema's lists of kinds, ease names and limits are compared with the constants in the code, so they cannot drift.
