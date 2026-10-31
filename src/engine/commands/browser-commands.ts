// Commands that only the running page can carry out: export (encoders), importing media bytes,
// recording (screen, camera and microphone permissions), packages (file pickers and zip streams),
// the library and saved templates and presets (browser storage) and batch export.
//
// They are registered here with full typed inputs so the command inventory is complete and the
// parity check can see them. `run` returns the typed error `needs-browser`; the host bridge
// (issue #33) implements them against the live page.
import { type CommandDef, type InputSpec, bool, browserCommand, num, oneOf, ref, seconds, str } from './define';

const RANGE = oneOf('range', ['whole', 'marks'], 'whole: the entire timeline (default); marks: the in to out marks.', { optional: true });
const OUT = str('out', 'Where to write the file (a path the host can reach). Without it the result carries a download.', { optional: true });
const PRESET = str('preset', 'Name of a built-in or saved export preset; the other inputs are applied on top of it.', { optional: true });
const SIZE = num('size', 'Short side of the picture in pixels (default: the project size).', { optional: true, min: 64, max: 4320, integer: true });
const QUALITY = oneOf('quality', ['small', 'standard', 'high'], 'Quality (default standard).', { optional: true });
const FPS = num('fps', 'Frames per second (default: the project rate).', { optional: true, min: 1, max: 60, integer: true });

const VIDEO_INPUTS: InputSpec[] = [
  PRESET,
  RANGE,
  SIZE,
  QUALITY,
  FPS,
  bool('includeAudio', 'Mix the sound into the file (default true).', { optional: true }),
  bool('captions', 'Burn the captions into the picture (default true).', { optional: true }),
  bool('fast', 'Decode source video in order with WebCodecs (default true; falls back to seeking by itself).', { optional: true }),
  bool('chapters', 'Also write sidecar chapter files when chapter markers exist (default false).', { optional: true }),
  OUT,
];

export const browserCommands: CommandDef[] = [
  browserCommand({
    name: 'export mp4',
    summary: 'Render the timeline to an H.264 MP4 with AAC (or Opus) sound.',
    inputs: VIDEO_INPUTS,
    result: 'Object with the file name or path, byte size, format and a one-line summary.',
  }),
  browserCommand({
    name: 'export gif',
    summary: 'Render the timeline to an animated GIF.',
    inputs: [
      PRESET,
      RANGE,
      SIZE,
      FPS,
      num('colors', 'Palette size, 2 to 256 (default 256).', { optional: true, min: 2, max: 256, integer: true }),
      bool('dither', 'Dither the palette (default false).', { optional: true }),
      bool('optimize', 'Store only the changed part of each frame (default true).', { optional: true }),
      bool('loop', 'Loop forever (default true).', { optional: true }),
      bool('captions', 'Burn the captions into the picture (default true).', { optional: true }),
      OUT,
    ],
    result: 'Object with the file name or path, byte size, format and a one-line summary.',
  }),
  browserCommand({
    name: 'export png',
    summary: 'Save one frame of the timeline as a PNG.',
    inputs: [
      seconds('time', 'Timeline position of the frame in seconds (default 0).', { optional: true }),
      PRESET,
      SIZE,
      bool('captions', 'Draw the captions (default true).', { optional: true }),
      OUT,
    ],
    result: 'Object with the file name or path, byte size and format.',
  }),
  browserCommand({
    name: 'export wav',
    summary: 'Mix the timeline’s sound to an uncompressed WAV file.',
    inputs: [PRESET, RANGE, OUT],
    result: 'Object with the file name or path, byte size and format.',
  }),
  browserCommand({
    name: 'export m4a',
    summary: 'Mix the timeline’s sound to an AAC M4A file.',
    inputs: [PRESET, RANGE, OUT],
    result: 'Object with the file name or path, byte size and format.',
  }),
  browserCommand({
    name: 'export cancel',
    summary: 'Cancel the export that is running, or the whole batch.',
    inputs: [],
    result: 'Object with cancelled: true.',
  }),
  browserCommand({
    name: 'preset save',
    summary: 'Save export settings as a named preset in this browser.',
    inputs: [
      str('name', 'Preset name.'),
      oneOf('format', ['mp4', 'gif', 'wav', 'm4a', 'png'], 'Export format.'),
      RANGE,
      SIZE,
      QUALITY,
      FPS,
      bool('includeAudio', 'Mix the sound in (default true).', { optional: true }),
      bool('captions', 'Burn the captions in (default true).', { optional: true }),
    ],
    result: 'Object with the preset id and name.',
  }),
  browserCommand({
    name: 'preset remove',
    summary: 'Delete a saved export preset.',
    inputs: [str('name', 'Preset name.')],
    result: 'Object with the preset name.',
    destructive: true,
  }),
  browserCommand({
    name: 'batch add',
    summary: 'Queue an export (a preset, or the current export settings) for the batch.',
    inputs: [PRESET, oneOf('format', ['mp4', 'gif', 'wav', 'm4a', 'png'], 'Export format when no preset is given.', { optional: true })],
    result: 'Object with the queue item id and label.',
  }),
  browserCommand({
    name: 'batch run',
    summary: 'Run every queued export in order.',
    inputs: [str('folder', 'Folder to write the files to (a path the host can reach).', { optional: true })],
    result: 'Object with counts of done, failed and cancelled items and the file names.',
  }),
  browserCommand({
    name: 'batch cancel',
    summary: 'Cancel a queued or running batch item.',
    inputs: [ref('item', 'Queue item id.')],
    result: 'Object with the item id.',
  }),
  browserCommand({
    name: 'batch retry',
    summary: 'Queue a failed or cancelled batch item again.',
    inputs: [ref('item', 'Queue item id.')],
    result: 'Object with the item id.',
  }),
  browserCommand({
    name: 'batch remove',
    summary: 'Remove one item from the batch queue.',
    inputs: [ref('item', 'Queue item id.')],
    result: 'Object with the item id.',
  }),
  browserCommand({
    name: 'batch clear',
    summary: 'Remove the finished items from the batch queue.',
    inputs: [],
    result: 'Object with how many items were removed.',
  }),
  browserCommand({
    name: 'media import',
    summary: 'Import media files (video, audio, images) into the project’s media bin.',
    inputs: [
      str('file', 'Path of a media file the host can read.'),
      str('name', 'Name to show in the bin (default: the file name).', { optional: true }),
      str('cursorData', 'Path of a .cursor.json file to attach (default: the file next to it, if any).', { optional: true }),
    ],
    result: 'Object with the new media item (id, name, kind, duration, size).',
  }),
  browserCommand({
    name: 'media import-captures',
    summary: 'Import the images and videos from a SnapShackle Captures folder.',
    inputs: [str('folder', 'Path of the Captures folder.')],
    result: 'Object with the media items added and how many older captures were left out.',
  }),
  browserCommand({
    name: 'record start',
    summary: 'Start a screen recording (and optionally webcam and microphone). The browser asks the person which screen, window or tab to share.',
    inputs: [
      oneOf('surface', ['browser', 'window', 'monitor'], 'What to share: a browser tab, a window or the entire screen (default window).', { optional: true }),
      bool('region', 'Pick a region of the shared surface to record.', { optional: true }),
      bool('hideCursor', 'Leave the mouse cursor out of the recording.', { optional: true }),
      bool('microphone', 'Record the microphone (default true).', { optional: true }),
      bool('systemAudio', 'Record the sound the computer plays (default true).', { optional: true }),
      bool('separateAudio', 'Keep microphone and system sound as separate tracks.', { optional: true }),
      bool('webcam', 'Record the camera as its own track.', { optional: true }),
      str('cameraId', 'Camera device id (default: the browser’s default camera).', { optional: true }),
      oneOf('webcamResolution', ['480', '720', '1080'], 'Camera resolution (default 720).', { optional: true }),
      bool('webcamPip', 'Place the camera as a picture-in-picture on the timeline (default true).', { optional: true }),
      oneOf('countdown', ['0', '3', '5'], 'Seconds of countdown before recording starts (default 3).', { optional: true }),
      num('maxMinutes', 'Stop by itself after this many minutes (0 = no limit).', { optional: true, min: 0, max: 1440 }),
      bool('toDisk', 'Write the recording to the browser’s private disk space as it goes, so a crash loses nothing (default true).', { optional: true }),
      bool('addToTimeline', 'Put the recording on the timeline when it stops (default true).', { optional: true }),
    ],
    result: 'Object with the recording session id and the surface that was shared.',
  }),
  browserCommand({
    name: 'record pause',
    summary: 'Pause the running recording; the pause is left out of the footage.',
    inputs: [],
    result: 'Object with the seconds recorded so far.',
  }),
  browserCommand({
    name: 'record resume',
    summary: 'Carry on a paused recording.',
    inputs: [],
    result: 'Object with the seconds recorded so far.',
  }),
  browserCommand({
    name: 'record stop',
    summary: 'Stop the recording and add it to the media bin (and the timeline).',
    inputs: [],
    result: 'Object with the media ids added and the recorded seconds.',
  }),
  browserCommand({
    name: 'record cancel',
    summary: 'Abandon the recording without keeping it.',
    inputs: [],
    result: 'Object with cancelled: true.',
    destructive: true,
  }),
  browserCommand({
    name: 'record recover',
    summary: 'Import a recording left behind by a crash or a closed window.',
    inputs: [ref('session', 'Recoverable session id.')],
    result: 'Object with the media ids added.',
  }),
  browserCommand({
    name: 'record discard',
    summary: 'Throw away a recording left behind by a crash or a closed window.',
    inputs: [ref('session', 'Recoverable session id.')],
    result: 'Object with the session id.',
    destructive: true,
  }),
  browserCommand({
    name: 'package save',
    summary: 'Save the project and all its media as one .capstanz package file.',
    inputs: [str('out', 'Where to write the package (a path the host can reach). Without it the browser asks.', { optional: true })],
    result: 'Object with the file name or path, byte size and how many media files it holds.',
  }),
  browserCommand({
    name: 'package open',
    summary: 'Open a .capstanz package: verify it, store its media, then open the project. A project already here opens as a copy.',
    inputs: [str('file', 'Path of the package file the host can read.')],
    result: 'Object with the opened project summary.',
    destructive: true,
  }),
  browserCommand({
    name: 'library add',
    summary: 'Add a file (logo, music, sting, short clip) to the library, which belongs to no project.',
    inputs: [str('file', 'Path of the file the host can read.')],
    result: 'Object with the library asset id and name.',
  }),
  browserCommand({
    name: 'library save',
    summary: 'Save a media item from this project to the library.',
    inputs: [ref('media', 'Media id.')],
    result: 'Object with the library asset id and name.',
  }),
  browserCommand({
    name: 'library use',
    summary: 'Add a library asset to this project’s media bin.',
    inputs: [ref('asset', 'Library asset id.')],
    result: 'Object with the new media id.',
  }),
  browserCommand({
    name: 'library remove',
    summary: 'Remove an asset from the library. Projects that already use it keep their own copy.',
    inputs: [ref('asset', 'Library asset id.')],
    result: 'Object with the asset id.',
    destructive: true,
  }),
  browserCommand({
    name: 'template save',
    summary: 'Save the project’s layout (size, tracks, annotations, zooms, markers, cursor settings) as a template in this browser.',
    inputs: [str('name', 'Template name.'), str('description', 'A line about it.', { optional: true })],
    result: 'Object with the template id and name.',
  }),
  browserCommand({
    name: 'template use',
    summary: 'Start a new project from a template saved in this browser.',
    inputs: [ref('template', 'Template id.'), str('name', 'Project name (default: the template name).', { optional: true })],
    result: 'Object with the new project summary.',
    destructive: true,
  }),
  browserCommand({
    name: 'template remove',
    summary: 'Delete a template saved in this browser.',
    inputs: [ref('template', 'Template id.')],
    result: 'Object with the template id.',
    destructive: true,
  }),
];
