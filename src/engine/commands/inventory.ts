// The GUI action inventory: every user-visible action in the editor that edits the project or
// produces data, and the command that does the same. The parity test keeps this honest in both
// directions: each entry names a registered command, and each registered command is used here
// unless it is marked `cliOnly`.
//
// Left out on purpose, because they change what is shown and not the project or its output:
// playback and seeking, timeline zoom and snapping, selection, the theme and sidebar toggles, the
// shortcuts dialog, the bin and inspector's go-to buttons, and the buttons that only open a dialog
// (Record screen, Export video, Library): the actions inside the dialog are listed instead.
//
// Ids read `<place>.<action>`. Where one command serves several controls (a field in the
// inspector, a drag in the timeline), each control has its own entry.

export interface GuiAction {
  /** Unique, such as `timeline.split`. */
  id: string;
  /** The part of the interface: toolbar, timeline, inspector.clip, panel.captions ... */
  area: string;
  /** What the person sees. */
  label: string;
  /** The registered command that performs it. */
  command: string;
}

const a = (id: string, area: string, label: string, command: string): GuiAction => ({ id, area, label, command });

export const GUI_ACTIONS: readonly GuiAction[] = [
  // ---- toolbar and sidebar ----
  a('toolbar.new-project', 'toolbar', 'New project', 'project new'),
  a('toolbar.open-project-file', 'toolbar', 'Open project file (.capstan)', 'project open'),
  a('toolbar.save-project-file', 'toolbar', 'Save project file (.capstan)', 'project save'),
  a('toolbar.undo', 'toolbar', 'Undo', 'history undo'),
  a('toolbar.redo', 'toolbar', 'Redo', 'history redo'),
  a('toolbar.split', 'toolbar', 'Split at playhead', 'clip split'),
  a('toolbar.delete', 'toolbar', 'Delete', 'clip delete'),
  a('sidebar.import', 'sidebar', 'Import media', 'media import'),
  a('sidebar.end-session', 'sidebar', 'End session', 'session end'),
  a('welcome.import', 'welcome', 'Import media', 'media import'),
  a('welcome.open', 'welcome', 'Open a project', 'project open'),
  a('welcome.projects', 'welcome', 'Projects', 'projects list'),
  a('welcome.templates', 'welcome', 'New from template', 'project from-template'),

  // ---- keyboard ----
  a('keys.split', 'keyboard', 'S: split at the playhead', 'clip split'),
  a('keys.delete', 'keyboard', 'Delete: delete the selected clips', 'clip delete'),
  a('keys.ripple-delete', 'keyboard', 'Shift+Delete: delete and close the gap', 'clip delete'),
  a('keys.delete-region', 'keyboard', 'Delete: delete the selected blur region', 'redaction remove'),
  a('keys.delete-annotation', 'keyboard', 'Delete: delete the selected annotation', 'annotation remove'),
  a('keys.delete-zoom', 'keyboard', 'Delete: delete the selected zoom region', 'zoom remove'),
  a('keys.delete-caption', 'keyboard', 'Delete: delete the selected caption', 'caption remove'),
  a('keys.delete-marker', 'keyboard', 'Delete: delete the selected marker', 'marker remove'),
  a('keys.add-marker', 'keyboard', 'M: add a marker at the playhead', 'marker add'),
  a('keys.cut', 'keyboard', 'Ctrl+X: cut the selected clips', 'clip delete'),
  a('keys.paste', 'keyboard', 'Ctrl+V: paste clips at the playhead', 'clip duplicate'),
  a('keys.duplicate', 'keyboard', 'Ctrl+D: duplicate the selected clips', 'clip duplicate'),
  a('keys.group', 'keyboard', 'G: group the selected clips', 'clip group'),
  a('keys.ungroup', 'keyboard', 'Shift+G: ungroup the selected clips', 'clip ungroup'),
  a('keys.mark-in', 'keyboard', 'I: mark the start of the part to export', 'range mark-in'),
  a('keys.mark-out', 'keyboard', 'O: mark the end of the part to export', 'range mark-out'),
  a('keys.clear-marks', 'keyboard', 'Alt+X: clear the in and out marks', 'range clear'),

  // ---- timeline ----
  a('timeline.add-track', 'timeline', 'Add track', 'track add'),
  a('timeline.remove-track', 'timeline', 'Remove track', 'track remove'),
  a('timeline.rename-track', 'timeline', 'Track name', 'track update'),
  a('timeline.hide-track', 'timeline', 'Hide or show track', 'track update'),
  a('timeline.mute-track', 'timeline', 'Mute or unmute track', 'track update'),
  a('timeline.lock-track', 'timeline', 'Lock or unlock track', 'track update'),
  a('timeline.magnetic-track', 'timeline', 'Magnetic track', 'track update'),
  a('timeline.close-gaps', 'timeline', 'Close all gaps on this track', 'clip close-gaps'),
  a('timeline.close-gap', 'timeline', 'Close this gap', 'clip remove-gap'),
  a('timeline.drag-clip', 'timeline', 'Drag a clip (or several, a group, a video with its audio)', 'clip move'),
  a('timeline.trim-clip-start', 'timeline', 'Drag a clip’s left edge', 'clip trim'),
  a('timeline.trim-clip-end', 'timeline', 'Drag a clip’s right edge', 'clip trim'),
  a('timeline.drop-media', 'timeline', 'Drag media from the bin onto a track', 'clip add'),
  a('timeline.drag-marker', 'timeline', 'Drag a marker', 'marker move'),
  a('timeline.mark-range', 'timeline', 'Drag in the strip under the ruler to mark the part to export', 'range set'),
  a('timeline.clear-range', 'timeline', 'Double-click the strip to clear the marks', 'range clear'),
  a('lane.annotation-retime', 'timeline', 'Move or trim an annotation in its lane', 'annotation update'),
  a('lane.blur-retime', 'timeline', 'Move or trim a blur region in its lane', 'redaction update'),
  a('lane.zoom-retime', 'timeline', 'Move or trim a zoom region in its lane', 'zoom update'),
  a('lane.caption-retime', 'timeline', 'Move or trim a caption in its lane', 'caption update'),
  a('waveform.add-volume-point', 'timeline', 'Click the volume line to add a point', 'audio point-set'),
  a('waveform.drag-volume-point', 'timeline', 'Drag a volume point', 'audio point-set'),
  a('waveform.delete-volume-point', 'timeline', 'Double-click a volume point to delete it', 'audio point-remove'),

  // ---- media bin ----
  a('media.import', 'media bin', 'Import', 'media import'),
  a('media.add-to-timeline', 'media bin', 'Add at playhead (or double-click)', 'clip add'),
  a('media.remove', 'media bin', 'Remove from project', 'media remove'),
  a('media.attach-cursor', 'media bin', 'Attach cursor data', 'cursor attach'),

  // ---- preview tools ----
  a('preview.move-clip', 'preview', 'Drag a clip in the picture', 'clip props'),
  a('preview.scale-clip', 'preview', 'Drag a clip’s corner to resize it', 'clip props'),
  a('preview.crop-clip', 'preview', 'Drag the crop handles', 'clip crop'),
  a('preview.move-annotation', 'preview', 'Drag an annotation', 'annotation move'),
  a('preview.resize-annotation', 'preview', 'Drag an annotation’s handles', 'annotation update'),
  a('preview.move-region', 'preview', 'Drag a blur region', 'redaction update'),
  a('preview.resize-region', 'preview', 'Resize a blur region', 'redaction update'),
  a('preview.move-zoom', 'preview', 'Drag a zoom region', 'zoom update'),
  a('preview.resize-zoom', 'preview', 'Resize a zoom region', 'zoom update'),

  // ---- inspector: project ----
  a('inspector.project-name', 'inspector.project', 'Name', 'project set'),
  a('inspector.project-canvas', 'inspector.project', 'Canvas size', 'project resize'),
  a('inspector.project-fps', 'inspector.project', 'Frame rate', 'project set'),
  a('inspector.project-background', 'inspector.project', 'Background', 'project set'),
  a('inspector.add-region', 'inspector.project', 'Add blur region at playhead', 'redaction add'),
  a('inspector.marker-name', 'inspector.project', 'Name a marker', 'marker rename'),
  a('inspector.marker-chapter', 'inspector.project', 'Chapter checkbox', 'marker chapter'),
  a('inspector.marker-delete', 'inspector.project', 'Delete marker', 'marker remove'),
  a('inspector.add-marker', 'inspector.project', 'Add marker at playhead', 'marker add'),

  // ---- inspector: clip ----
  a('inspector.clip-scale', 'inspector.clip', 'Scale', 'clip props'),
  a('inspector.clip-position', 'inspector.clip', 'Position X and Y', 'clip props'),
  a('inspector.clip-rotation', 'inspector.clip', 'Rotation', 'clip props'),
  a('inspector.clip-opacity', 'inspector.clip', 'Opacity', 'clip props'),
  a('inspector.clip-volume', 'inspector.clip', 'Volume', 'clip props'),
  a('inspector.clip-reset', 'inspector.clip', 'Reset position', 'clip props'),
  a('inspector.clip-duplicate', 'inspector.clip', 'Duplicate', 'clip duplicate'),
  a('inspector.clip-speed', 'inspector.clip', 'Playback speed', 'clip speed'),
  a('inspector.clip-freeze', 'inspector.clip', 'Freeze frame', 'clip freeze'),
  a('inspector.clip-extend', 'inspector.clip', 'Extend frame', 'clip extend'),
  a('inspector.clip-crop-fields', 'inspector.clip', 'Crop left, top, width, height', 'clip crop'),
  a('inspector.clip-crop-shape', 'inspector.clip', 'Crop shape (aspect ratio)', 'clip crop'),
  a('inspector.clip-crop-reset', 'inspector.clip', 'Reset crop', 'clip crop'),
  a('inspector.clip-detach-audio', 'inspector.clip', 'Detach audio', 'clip detach-audio'),
  a('inspector.clip-unlink', 'inspector.clip', 'Unlink', 'clip unlink'),
  a('inspector.clips-group', 'inspector.clip', 'Group (several clips selected)', 'clip group'),
  a('inspector.clips-ungroup', 'inspector.clip', 'Ungroup', 'clip ungroup'),
  a('inspector.clips-cut', 'inspector.clip', 'Cut', 'clip delete'),
  a('inspector.clips-duplicate', 'inspector.clip', 'Duplicate (several clips)', 'clip duplicate'),
  a('inspector.clips-delete', 'inspector.clip', 'Delete (several clips)', 'clip delete'),

  // ---- inspector: animation ----
  a('inspector.key-add', 'inspector.animation', 'Add a key at the playhead', 'keyframe set'),
  a('inspector.key-remove', 'inspector.animation', 'Remove the key at the playhead', 'keyframe remove'),
  a('inspector.key-delete', 'inspector.animation', 'Delete this key', 'keyframe remove'),
  a('inspector.key-ease', 'inspector.animation', 'Easing for a key', 'keyframe ease'),
  a('inspector.keys-clear', 'inspector.animation', 'Clear all keys', 'keyframe clear'),
  a('inspector.transition-set', 'inspector.animation', 'Transition in or out', 'transition set'),
  a('inspector.transition-clear', 'inspector.animation', 'Transition: None', 'transition clear'),
  a('inspector.behavior-set', 'inspector.animation', 'Behavior enter, emphasis, exit', 'behavior set'),
  a('inspector.behavior-clear', 'inspector.animation', 'Behavior: None', 'behavior clear'),

  // ---- inspector: audio ----
  a('inspector.audio-fade', 'inspector.audio', 'Fade in, fade out, fade shape', 'audio fade'),
  a('inspector.audio-point-add', 'inspector.audio', 'Add a volume point at the playhead', 'audio point-set'),
  a('inspector.audio-point-remove', 'inspector.audio', 'Remove a volume point', 'audio point-remove'),
  a('inspector.audio-points-clear', 'inspector.audio', 'Clear volume points', 'audio points-clear'),
  a('inspector.audio-level', 'inspector.audio', 'Level volume', 'audio level'),
  a('inspector.audio-denoise', 'inspector.audio', 'Remove noise', 'audio denoise'),
  a('inspector.audio-duck', 'inspector.audio', 'Ducking on and its settings', 'audio duck'),

  // ---- inspector: effects ----
  a('inspector.effects-edit', 'inspector.effects', 'Colour, green screen, shadow, border, corners, mask, blend, device frame', 'effects set'),
  a('inspector.effects-clear', 'inspector.effects', 'Clear effects', 'effects clear'),

  // ---- inspector: blur region ----
  a('inspector.region-mode', 'inspector.region', 'Effect: blur or pixelate', 'redaction update'),
  a('inspector.region-strength', 'inspector.region', 'Strength', 'redaction update'),
  a('inspector.region-timing', 'inspector.region', 'Starts at and length', 'redaction update'),
  a('inspector.region-box', 'inspector.region', 'Left, top, width, height', 'redaction update'),
  a('inspector.region-delete', 'inspector.region', 'Delete region', 'redaction remove'),

  // ---- inspector: annotation ----
  a('inspector.annotation-text', 'inspector.annotation', 'Text', 'annotation update'),
  a('inspector.annotation-style', 'inspector.annotation', 'Font, size, bold, italic, alignment, colours, outline, corners, shadow, dimming', 'annotation update'),
  a('inspector.annotation-sketch', 'inspector.annotation', 'Draw on over', 'annotation update'),
  a('inspector.annotation-timing', 'inspector.annotation', 'Start and duration', 'annotation update'),
  a('inspector.annotation-box', 'inspector.annotation', 'Opacity, rotation, left, top, box width and height', 'annotation update'),
  a('inspector.annotation-duplicate', 'inspector.annotation', 'Duplicate', 'annotation duplicate'),
  a('inspector.annotation-front', 'inspector.annotation', 'Bring to front', 'annotation reorder'),
  a('inspector.annotation-back', 'inspector.annotation', 'Send to back', 'annotation reorder'),
  a('inspector.annotation-delete', 'inspector.annotation', 'Delete', 'annotation remove'),

  // ---- inspector: caption ----
  a('inspector.caption-text', 'inspector.caption', 'Caption text', 'caption update'),
  a('inspector.caption-timing', 'inspector.caption', 'Start and end', 'caption update'),
  a('inspector.caption-split', 'inspector.caption', 'Split at the playhead', 'caption split'),
  a('inspector.caption-merge', 'inspector.caption', 'Merge with next', 'caption merge'),
  a('inspector.caption-delete', 'inspector.caption', 'Delete', 'caption remove'),

  // ---- inspector: marker ----
  a('inspector.marker-panel-name', 'inspector.marker', 'Name', 'marker rename'),
  a('inspector.marker-panel-chapter', 'inspector.marker', 'Chapter', 'marker chapter'),
  a('inspector.marker-panel-move', 'inspector.marker', 'Move to the playhead', 'marker move'),
  a('inspector.marker-panel-delete', 'inspector.marker', 'Delete', 'marker remove'),

  // ---- inspector: zoom ----
  a('inspector.zoom-level', 'inspector.zoom', 'Zoom, left and top', 'zoom update'),
  a('inspector.zoom-timing', 'inspector.zoom', 'Starts at, length, zoom in over, zoom out over', 'zoom update'),
  a('inspector.zoom-ease', 'inspector.zoom', 'Easing', 'zoom update'),
  a('inspector.zoom-duplicate', 'inspector.zoom', 'Duplicate', 'zoom duplicate'),
  a('inspector.zoom-delete', 'inspector.zoom', 'Delete', 'zoom remove'),

  // ---- toolbox panels ----
  a('panel.annotation-add', 'panel.annotations', 'Add text, callout, rectangle, ellipse, arrow, line, highlight, spotlight', 'annotation add'),
  a('panel.cover-add', 'panel.annotations', 'Hide details: blur or pixelate', 'redaction add'),
  a('panel.annotation-preset', 'panel.annotations', 'Style presets', 'annotation preset'),
  a('panel.captions-add', 'panel.captions', 'Add caption at playhead', 'caption add'),
  a('panel.captions-split', 'panel.captions', 'Split at the playhead', 'caption split'),
  a('panel.captions-import', 'panel.captions', 'Import SRT or WebVTT', 'caption set'),
  a('panel.captions-save-srt', 'panel.captions', 'Save SRT', 'caption export-srt'),
  a('panel.captions-save-vtt', 'panel.captions', 'Save WebVTT', 'caption export-vtt'),
  a('panel.captions-clear', 'panel.captions', 'Clear all captions', 'caption clear'),
  a('panel.captions-earlier', 'panel.captions', 'Shift earlier', 'caption shift'),
  a('panel.captions-later', 'panel.captions', 'Shift later', 'caption shift'),
  a('panel.captions-edit-text', 'panel.captions', 'Edit a caption’s text in the list', 'caption update'),
  a('panel.captions-delete', 'panel.captions', 'Delete a caption in the list', 'caption remove'),
  a('panel.motion-zoom-add', 'panel.motion', 'Add zoom at playhead', 'zoom add'),
  a('panel.motion-transition', 'panel.motion', 'Transition presets', 'transition set'),
  a('panel.motion-transition-clear', 'panel.motion', 'Transition: none', 'transition clear'),
  a('panel.motion-behavior', 'panel.motion', 'Behavior presets', 'behavior set'),
  a('panel.motion-behavior-clear', 'panel.motion', 'Behavior: none', 'behavior clear'),
  a('panel.effects-preset', 'panel.effects', 'Effect presets', 'effects preset'),
  a('panel.effects-clear', 'panel.effects', 'Clear effects', 'effects clear'),
  a('panel.audio-fade-in', 'panel.audio', 'Fade in 0.5 s', 'audio fade'),
  a('panel.audio-fade-out', 'panel.audio', 'Fade out 0.5 s', 'audio fade'),
  a('panel.audio-level', 'panel.audio', 'Level volume', 'audio level'),
  a('panel.audio-denoise', 'panel.audio', 'Remove noise', 'audio denoise'),
  a('panel.audio-duck', 'panel.audio', 'Duck other tracks under this clip', 'audio duck'),
  a('panel.cursor-settings', 'panel.cursor', 'Cursor, highlight, magnify, spotlight, clicks, keystrokes', 'cursor settings'),
  a('panel.cursor-image', 'panel.cursor', 'Replace cursor image', 'cursor settings'),
  a('panel.cursor-image-remove', 'panel.cursor', 'Use the built-in cursor again', 'cursor settings'),
  a('panel.cursor-detach', 'panel.cursor', 'Remove cursor data', 'cursor detach'),
  a('panel.cursor-attach', 'panel.cursor', 'Attach cursor data', 'cursor attach'),
  a('panel.cursor-suggest', 'panel.cursor', 'Suggest zoom regions (smart focus)', 'zoom suggest'),
  a('panel.cursor-accept', 'panel.cursor', 'Add the picked zoom regions', 'zoom accept'),

  // ---- project menu and dialogs ----
  a('project-menu.projects', 'project menu', 'Projects…', 'projects list'),
  a('project-menu.save-package', 'project menu', 'Save package (.capstanz)', 'package save'),
  a('project-menu.open-package', 'project menu', 'Open package…', 'package open'),
  a('project-menu.snapshackle', 'project menu', 'Import from SnapShackle captures…', 'media import-captures'),
  a('projects-dialog.open', 'projects dialog', 'Open', 'projects open'),
  a('projects-dialog.rename', 'projects dialog', 'Rename', 'projects rename'),
  a('projects-dialog.duplicate', 'projects dialog', 'Duplicate', 'projects duplicate'),
  a('projects-dialog.delete', 'projects dialog', 'Delete', 'projects delete'),
  a('templates-dialog.save', 'templates dialog', 'Save this project as a template', 'template save'),
  a('templates-dialog.use-builtin', 'templates dialog', 'New project from a built-in template', 'project from-template'),
  a('templates-dialog.use-saved', 'templates dialog', 'New project from a saved template', 'template use'),
  a('templates-dialog.delete', 'templates dialog', 'Delete template', 'template remove'),
  a('templates-dialog.theme', 'templates dialog', 'Apply a theme', 'project theme'),
  a('library-dialog.add', 'library dialog', 'Add files…', 'library add'),
  a('library-dialog.use', 'library dialog', 'Add to this project', 'library use'),
  a('library-dialog.remove', 'library dialog', 'Remove from the library', 'library remove'),
  a('library-dialog.save-media', 'library dialog', 'Save from this project', 'library save'),

  // ---- export dialog ----
  a('export.mp4', 'export dialog', 'Export MP4', 'export mp4'),
  a('export.gif', 'export dialog', 'Export animated GIF', 'export gif'),
  a('export.png', 'export dialog', 'Export current frame as PNG', 'export png'),
  a('export.wav', 'export dialog', 'Export audio as WAV', 'export wav'),
  a('export.m4a', 'export dialog', 'Export audio as M4A', 'export m4a'),
  a('export.cancel', 'export dialog', 'Cancel export or batch', 'export cancel'),
  a('export.chapters', 'export dialog', 'Also save chapter files', 'marker export-chapters'),
  a('export.preset-save', 'export dialog', 'Save preset', 'preset save'),
  a('export.preset-delete', 'export dialog', 'Delete preset', 'preset remove'),
  a('export.batch-add', 'export dialog', 'Add to batch', 'batch add'),
  a('export.batch-run', 'export dialog', 'Run batch', 'batch run'),
  a('export.batch-cancel', 'export dialog', 'Cancel a batch item', 'batch cancel'),
  a('export.batch-retry', 'export dialog', 'Retry a batch item', 'batch retry'),
  a('export.batch-remove', 'export dialog', 'Remove a batch item', 'batch remove'),
  a('export.batch-clear', 'export dialog', 'Clear finished', 'batch clear'),

  // ---- record dialog and recovery ----
  a('record.start', 'record dialog', 'Start recording', 'record start'),
  a('record.pause', 'record dialog', 'Pause', 'record pause'),
  a('record.resume', 'record dialog', 'Resume', 'record resume'),
  a('record.stop', 'record dialog', 'Stop and save', 'record stop'),
  a('record.cancel', 'record dialog', 'Cancel', 'record cancel'),
  a('recovery.import', 'recovery dialog', 'Import a recovered recording', 'record recover'),
  a('recovery.discard', 'recovery dialog', 'Discard a recovered recording', 'record discard'),
];
