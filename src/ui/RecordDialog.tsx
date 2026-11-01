import { useEffect, useRef, useState } from 'react';
import type { CursorData } from '../engine/cursor';
import { type CaptureBounds, CursorCapture, type ScreenLike, monitorBounds, newRecordingId } from '../engine/cursor-capture';
import { type HotkeyEvent, acceptMarkerTime, applyRecordingMarkers, decideHotkey, trayStateFor } from '../engine/hotkeys-host';
import { projectDuration } from '../engine/project';
import { type CaptureSurface, SURFACE_LABEL, ScreenRecorder } from '../engine/recorder';
import {
  CAPTURE_NEEDS_SCREEN,
  LAST_USED_KEY,
  type RecordSettings,
  attachCaptured,
  captureLabel,
  captureRequest,
  defaultSettings,
  importRecordingSet,
  lastUsedFrom,
  parseLastUsed,
  placeAtEnd,
  primaryClip,
  settingsToPrefs,
  toRecordOptions,
} from '../engine/recording-flow';
import {
  COUNTDOWN_CHOICES,
  type CountdownSeconds,
  DEFAULT_PREFS,
  type RecordPrefs,
  WEBCAM_RESOLUTIONS,
  countdownValue,
  limitState,
  minutesToSeconds,
  parsePrefs,
} from '../engine/recording-sources';
import { type PlacementPlan, type RecordingStore, openRecordingStore } from '../engine/recording-store';
import { type Rect, fullRect, rectToCrop } from '../engine/region';
import { download, timecode } from './format';
import { hotkeyHint, HotkeysPanel } from './HotkeysPanel';
import { hotkeysWork, onHotkey, setTrayState, useHotkeyStatus } from './hotkeys';
import { Icon } from './icons';
import { markBusy, sessionToken } from './lifecycle';
import { RegionPicker } from './RegionPicker';
import { useModal } from './shell';
import type { Editor } from './useEditor';

const PREFS_KEY = 'capstan-record-prefs';

function loadPrefs(): RecordPrefs {
  try {
    return parsePrefs(window.localStorage.getItem(PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
function savePrefs(p: RecordPrefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* not remembered */
  }
}

function loadLast() {
  try {
    return parseLastUsed(window.localStorage.getItem(LAST_USED_KEY));
  } catch {
    return {};
  }
}
function saveLast(v: ReturnType<typeof lastUsedFrom>) {
  try {
    window.localStorage.setItem(LAST_USED_KEY, JSON.stringify(v));
  } catch {
    /* not remembered */
  }
}

type Phase = 'setup' | 'region' | 'armed' | 'countdown' | 'recording' | 'paused' | 'saving';

const NEEDS_CLICK =
  'The browser opens its screen picker only after a click inside Capstan, so a key pressed in another program cannot start the first recording. Click Start recording once to choose what to share. To start with a key afterwards, tick “Choose what to share now, then start with the hotkey”.';

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function RecordDialog({ editor, onClose, autostart = false }: { editor: Editor; onClose(): void; autostart?: boolean }) {
  const initial = useRef(loadPrefs()).current;
  const last = useRef(loadLast()).current;
  const [microphone, setMicrophone] = useState(last.microphone ?? true);
  const [systemAudio, setSystemAudio] = useState(last.systemAudio ?? true);
  const [separateAudio, setSeparateAudio] = useState(initial.separateAudio);
  const [addToTimeline, setAddToTimeline] = useState(last.addToTimeline ?? true);
  const [surface, setSurface] = useState<CaptureSurface>(last.surface ?? 'window');
  const [webcam, setWebcam] = useState(last.webcam ?? false);
  const [cameraId, setCameraId] = useState(last.cameraId ?? '');
  const [cameras, setCameras] = useState<Array<{ id: string; label: string }>>([]);
  const [webcamResolution, setWebcamResolution] = useState(initial.webcamResolution);
  const [webcamPip, setWebcamPip] = useState(initial.webcamPip);
  const [countdown, setCountdown] = useState<CountdownSeconds>(initial.countdown);
  const [maxMinutes, setMaxMinutes] = useState(initial.maxMinutes ? String(initial.maxMinutes) : '');
  const [toDisk, setToDisk] = useState(initial.toDisk);
  const [pickRegion, setPickRegion] = useState(false);
  const [hideCursor, setHideCursor] = useState(last.hideCursor ?? false);
  const [armFirst, setArmFirst] = useState(last.armFirst ?? false);
  const [flash, setFlash] = useState('');
  const { status: hotkeys } = useHotkeyStatus();
  // Cursor capture is off every time the dialog opens: it is never remembered between recordings.
  const [captureCursor, setCaptureCursor] = useState(false);
  const [captureKeys, setCaptureKeys] = useState(false);
  /** Set while the host is logging the cursor (and shortcuts, if asked): drives the indicator in the recording bar. */
  const [capturing, setCapturing] = useState<{ keys: boolean } | null>(null);
  const [notice, setNotice] = useState('');

  const [phase, setPhase] = useState<Phase>('setup');
  const [elapsed, setElapsed] = useState(0);
  const [diskBytes, setDiskBytes] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const [still, setStill] = useState<{ url: string; width: number; height: number } | null>(null);
  const [region, setRegion] = useState<Rect | null>(null);
  const [error, setError] = useState('');
  const [unsaved, setUnsaved] = useState<File | null>(null);
  const [starting, setStarting] = useState(false);

  const recorder = useRef<ScreenRecorder | null>(null);
  const store = useRef<RecordingStore | null>(null);
  const capture = useRef<{ client: CursorCapture; id: string; bounds: CaptureBounds; keys: boolean } | null>(null);
  const plan = useRef<PlacementPlan>({ pip: true });
  const phaseRef = useRef<Phase>('setup');
  const alive = useRef(true);
  const finishing = useRef(false);
  const beginning = useRef(false);
  // Marker hotkey presses during the recording, in seconds of footage (pauses excluded).
  const markerTimes = useRef<number[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  phaseRef.current = phase;

  const maxSeconds = minutesToSeconds(Number(maxMinutes));
  const limit = limitState(elapsed, maxSeconds);

  // Back to the setup step, dropping a shared-but-not-yet-recording screen.
  const abandon = (message = '') => {
    recorder.current?.cancel();
    recorder.current = null;
    void capture.current?.client.cancel();
    capture.current = null;
    setCapturing(null);
    beginning.current = false;
    setStill(null);
    setPhase('setup');
    setError(message);
  };
  // Esc closes the setup, and backs out of the region and countdown steps; never mid-recording.
  useModal(dialogRef, phase === 'setup' ? onClose : phase === 'region' || phase === 'armed' || phase === 'countdown' ? () => abandon() : undefined);

  // Each step has its own primary control; put focus on it when the step changes.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [phase]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => {
      setElapsed(recorder.current?.elapsed ?? 0);
      setDiskBytes(recorder.current?.sessionId ? (recorder.current?.bytesOnDisk ?? 0) : null);
    }, 200);
    return () => clearInterval(timer);
  }, [phase]);

  // The length limit: stop and save when it is reached.
  useEffect(() => {
    if (phase === 'recording' && limit.reached && !finishing.current) void finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, limit.reached]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      recorder.current?.cancel();
      void capture.current?.client.cancel();
    };
  }, []);

  // The tray icon and menu follow the recorder.
  useEffect(() => {
    setTrayState(trayStateFor(phase));
  }, [phase]);
  useEffect(() => () => setTrayState('idle'), []);

  // Recording and saving run in this page; tell the host so it never gives up on this window meanwhile.
  const active = phase !== 'setup';
  useEffect(() => (active || starting ? markBusy() : undefined), [active, starting]);

  // The camera list: names only appear once the page has had camera permission once.
  useEffect(() => {
    if (!webcam || !navigator.mediaDevices?.enumerateDevices) return;
    let stale = false;
    void navigator.mediaDevices.enumerateDevices().then((all) => {
      if (stale) return;
      const list = all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      setCameras(list);
    });
    return () => {
      stale = true;
    };
  }, [webcam]);

  const finish = async () => {
    const r = recorder.current;
    if (!r || finishing.current) return;
    finishing.current = true;
    setPhase('saving');
    let file: File | null = null;
    let session: string | null = null;
    // The host stops logging at once (not after the recorder has flushed); its answer is read below.
    const cap = capture.current;
    capture.current = null;
    const hostText = cap?.client.active ? cap.client.stop().catch((e: unknown) => e as Error) : null;
    setCapturing(null);
    try {
      const rec = await r.stop();
      recorder.current = null;
      session = rec.session;
      file = new File([rec.blob], rec.name, { type: rec.blob.type });
      let cursorData: CursorData | null = null;
      const cursorNotes: string[] = [];
      if (cap && hostText) {
        const got = await hostText;
        if (typeof got === 'string') {
          try {
            cursorData = cap.client.collect(got, rec.seconds);
          } catch (e) {
            cursorNotes.push(`${(e as Error).message} The recording has no cursor data.`);
          }
        } else cursorNotes.push(`${got.message} The recording has no cursor data.`);
      }
      const { parts, problems } = await importRecordingSet(rec, (f, hints) => editor.importRecording(f, hints));
      // The new recording gets its cursor data in the same undo step as its place on the timeline.
      let next = editor.getProject();
      const hadFx = !!next.cursorFx;
      if (cursorData) {
        next = attachCaptured(next, parts[0].media.id, cursorData);
        cursorNotes.push(
          `Cursor data attached: ${cursorData.samples.length} positions, ${cursorData.clicks.filter((c) => c.down).length} clicks, ${cursorData.keys.filter((k) => k.down).length} shortcuts.` +
            (hadFx && !next.cursorFx?.showCursor ? ' Turn on “Draw the cursor” in the Cursor tab to show the pointer.' : ''),
        );
      }
      let committed = false;
      let markersPlaced = false;
      if (addToTimeline) {
        // The recording goes at the end of the timeline; markers taken during it are offset by that start.
        const start = projectDuration(next);
        const placed = placeAtEnd(next, parts, plan.current);
        if (placed) {
          editor.commit(applyRecordingMarkers(placed.project, start, markerTimes.current));
          editor.setSelection([primaryClip(placed)!]);
          committed = true;
          markersPlaced = true;
        }
      }
      if (cursorData && !committed) editor.commit(next);
      if (rec.session) void store.current?.markImported(rec.session).catch(() => undefined);
      const notes = [...rec.notes, ...problems, ...(notice ? [notice] : []), ...cursorNotes];
      if (markerTimes.current.length && !markersPlaced) notes.push('The markers were not added because the recording is not on the timeline.');
      if (notes.length) editor.setStatus(notes.join(' '));
      onClose();
    } catch (e) {
      // Keep the footage: the file can still be saved even if it could not join the project.
      if (file) setUnsaved(file);
      setError(`${(e as Error).message}${file ? ` Save the recording file so it is not lost.${session ? ' A copy is also kept on disk and offered for recovery the next time Capstan starts.' : ''}` : ''}`);
      setPhase('setup');
    } finally {
      finishing.current = false;
    }
  };

  // Everything is shared and checked: record now, or after the countdown.
  const beginRecording = async () => {
    const r = recorder.current;
    if (!r || !r.isPrepared || beginning.current) return;
    beginning.current = true;
    try {
      // The host starts logging just before the recorders start; the gap between the two clocks is measured, not assumed.
      const cap = capture.current;
      if (cap) {
        try {
          await cap.client.start(cap.id, cap.bounds, cap.keys);
          setCapturing({ keys: cap.keys });
        } catch (e) {
          capture.current = null;
          setNotice(`Cursor capture could not start: ${(e as Error).message} The pointer is not in this recording.`);
        }
      }
      await r.begin(plan.current);
      markerTimes.current = [];
      setFlash('');
      capture.current?.client.mediaStarted(r.startTime);
      setElapsed(0);
      setDiskBytes(null);
      finishing.current = false;
      setPhase('recording');
    } catch (e) {
      abandon((e as Error).message);
    } finally {
      beginning.current = false;
    }
  };

  // The screen is shared and checked: wait for the hotkey ("armed"), or go on to the countdown.
  const afterShared = () => {
    if (armFirst && hotkeysWork(hotkeys)) setPhase('armed');
    else startCountdown();
  };

  const startCountdown = () => {
    if (countdown > 0) {
      setCount(countdown);
      setPhase('countdown');
    } else void beginRecording();
  };

  useEffect(() => {
    if (phase !== 'countdown') return;
    const deadline = performance.now() + countdown * 1000;
    const timer = setInterval(() => {
      const left = deadline - performance.now();
      setCount(countdownValue(left));
      if (left <= 0) {
        clearInterval(timer);
        void beginRecording();
      }
    }, 100);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const start = async () => {
    setError('');
    setUnsaved(null);
    setStarting(true);
    finishing.current = false;
    const settings: RecordSettings = {
      ...defaultSettings(),
      surface,
      microphone,
      systemAudio,
      separateAudio,
      webcam,
      cameraId,
      webcamResolution,
      webcamPip,
      countdown,
      maxMinutes: Number(maxMinutes) > 0 ? Number(maxMinutes) : 0,
      toDisk,
      pickRegion,
      hideCursor,
      captureCursor,
      captureKeys: captureCursor && captureKeys,
      addToTimeline,
    };
    // Cursor capture needs the host; check before the picture is shared, because capturing hides the pointer from the video.
    setNotice('');
    capture.current = null;
    const wanted = captureRequest(settings);
    if (wanted) {
      const bounds = monitorBounds(window.screen as ScreenLike, window.devicePixelRatio);
      const client = new CursorCapture({ token: sessionToken() });
      const why = bounds ? await client.probe() : 'The size of the screen could not be read, so the pointer was recorded normally.';
      if (why || !bounds) {
        settings.captureCursor = false;
        settings.captureKeys = false;
        setNotice(why ?? '');
      } else capture.current = { client, id: newRecordingId(), bounds, keys: wanted.keys };
    }
    savePrefs(settingsToPrefs(settings));
    saveLast(lastUsedFrom(settings, armFirst));
    const r = new ScreenRecorder();
    recorder.current = r;
    r.onEnded = () => {
      if (phaseRef.current === 'recording' || phaseRef.current === 'paused') void finish();
      else if (phaseRef.current === 'region' || phaseRef.current === 'armed' || phaseRef.current === 'countdown') abandon('Screen sharing ended before recording started.');
    };
    try {
      if (toDisk && !store.current) store.current = await openRecordingStore();
      await r.prepare(toRecordOptions(settings, editor.project, store.current));
      if (!alive.current) {
        r.cancel();
        return;
      }
      plan.current = { pip: webcamPip };
      if (pickRegion) {
        const s = await r.grabStill();
        setStill(s);
        setRegion(fullRect(s));
        setPhase('region');
      } else {
        afterShared();
      }
    } catch (e) {
      r.cancel();
      recorder.current = null;
      capture.current = null;
      const err = e as Error;
      if (alive.current) setError(err.name === 'NotAllowedError' ? 'Screen sharing was cancelled or blocked.' : err.message);
    } finally {
      setStarting(false);
    }
  };

  const confirmRegion = () => {
    if (still && region) plan.current = { ...plan.current, crop: rectToCrop(region, still) };
    setStill(null);
    afterShared();
  };

  // Global hotkeys (from the host's long poll). The newest handler is asked first; this dialog answers while it is open.
  const hotkeyRef = useRef<(e: HotkeyEvent) => boolean>(() => false);
  hotkeyRef.current = (e) => {
    if (e.name === 'tray-open') return false;
    const canStartNow = !starting && !beginning.current && (navigator.userActivation?.isActive ?? false);
    const decision = decideHotkey(phaseRef.current, e.name, canStartNow);
    switch (decision) {
      case 'start':
        void start();
        break;
      case 'need-click':
        setError(NEEDS_CLICK);
        break;
      case 'go':
        if (phaseRef.current === 'armed') startCountdown();
        else void beginRecording();
        break;
      case 'stop':
        void finish();
        break;
      case 'pause':
        recorder.current?.pause();
        setPhase('paused');
        break;
      case 'resume':
        recorder.current?.resume();
        setPhase('recording');
        break;
      case 'marker': {
        const t = recorder.current?.elapsed ?? -1;
        if (acceptMarkerTime(markerTimes.current, t)) {
          markerTimes.current.push(t);
          setFlash(`Marker ${markerTimes.current.length} added at ${timecode(t)}.`);
        }
        break;
      }
      case 'ignore':
        // A marker with nothing recording falls through to the editor (a marker at the playhead).
        return e.name !== 'marker';
    }
    return true;
  };
  useEffect(() => onHotkey((e) => hotkeyRef.current(e)), []);
  // Opened by the start key: start with the last used settings if the browser allows it, else say what is needed.
  useEffect(() => {
    if (autostart) hotkeyRef.current({ id: 0, name: 'start-stop', at: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keysLive = hotkeysWork(hotkeys) && hotkeys ? hotkeys.bindings : null;

  const setup = phase === 'setup';
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`modal fl-dialog record-modal${phase === 'region' ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-title"
      >
        <header className="modal-head">
          <h2 id="record-title">{phase === 'region' ? 'Select region' : 'Record screen'}</h2>
          {setup && (
            <button className="icon-button" onClick={onClose} title="Close (Esc)" aria-label="Close">
              <Icon name="close" />
            </button>
          )}
        </header>

        {setup && (
          <>
            <div className="record-body">
              <fieldset className="options surface-choice">
                <legend>What to record</legend>
                {(['browser', 'window', 'monitor'] as CaptureSurface[]).map((s) => (
                  <label key={s} className="check">
                    <input type="radio" name="surface" value={s} checked={surface === s} onChange={() => setSurface(s)} />
                    {s === 'browser' ? 'A browser tab' : s === 'window' ? 'A window' : 'The entire screen'}
                  </label>
                ))}
                <label className="check">
                  <input type="checkbox" checked={hideCursor} onChange={(e) => setHideCursor(e.target.checked)} />
                  Hide the mouse pointer in the recording (if the browser allows it)
                </label>
                <label className="check">
                  <input type="checkbox" checked={pickRegion} onChange={(e) => setPickRegion(e.target.checked)} />
                  Select a region first (the whole screen is still recorded; the region becomes a crop)
                </label>
              </fieldset>

              <fieldset className="options record-group">
                <legend>Cursor effects</legend>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={captureCursor && surface === 'monitor'}
                    disabled={surface !== 'monitor'}
                    aria-describedby="cursor-capture-note"
                    onChange={(e) => setCaptureCursor(e.target.checked)}
                  />
                  Capture cursor and keys for effects
                </label>
                <p className="hint record-meta" id="cursor-capture-note">
                  {surface !== 'monitor'
                    ? CAPTURE_NEEDS_SCREEN
                    : 'While you record, the Capstan host on this computer logs where the mouse pointer is and when its buttons are pressed. The pointer is left out of the video and drawn again from this log, so you can smooth it, highlight clicks and zoom to it. The log is saved in %LOCALAPPDATA%\\Capstan\\recordings and in your project, and it never leaves this computer.'}
                </p>
                {captureCursor && surface === 'monitor' && (
                  <>
                    <label className="check">
                      <input type="checkbox" checked={captureKeys} aria-describedby="cursor-keys-note" onChange={(e) => setCaptureKeys(e.target.checked)} />
                      Include keyboard shortcuts
                    </label>
                    <p className="hint record-meta" id="cursor-keys-note">
                      Records function keys and key combinations that use Ctrl, Alt or the Windows key, such as Ctrl+C, so they can be shown as callouts. Typed letters, numbers and punctuation are never recorded.
                    </p>
                  </>
                )}
              </fieldset>
              <p className="modal-text">
                {surface === 'monitor'
                  ? 'Your browser will ask which screen to record. Everything on it is captured.'
                  : surface === 'window'
                    ? 'Your browser will ask which window to record. Only that window is captured, at its own size, even if other windows cover it. Screens are not offered, and anything else is refused.'
                    : `Your browser will ask which ${SURFACE_LABEL[surface]} to record. Screens are not offered, and anything else is refused.`}{' '}
                Larger sources are scaled to the {editor.project.width}×{editor.project.height} canvas. The recording stays on this computer.
              </p>

              <fieldset className="options record-group">
                <legend>Sound</legend>
                <label className="check">
                  <input type="checkbox" checked={microphone} onChange={(e) => setMicrophone(e.target.checked)} />
                  Record my microphone
                </label>
                <label className="check">
                  <input type="checkbox" checked={systemAudio} onChange={(e) => setSystemAudio(e.target.checked)} />
                  Record computer sound (choose “Share audio” in the browser prompt)
                </label>
                <label className="check">
                  <input type="checkbox" checked={separateAudio} onChange={(e) => setSeparateAudio(e.target.checked)} />
                  Record audio on separate tracks (microphone and computer sound each get their own track)
                </label>
              </fieldset>

              <fieldset className="options record-group">
                <legend>Webcam</legend>
                <label className="check">
                  <input type="checkbox" checked={webcam} onChange={(e) => setWebcam(e.target.checked)} />
                  Record my webcam on its own track
                </label>
                {webcam && (
                  <div className="record-row">
                    <div className="field wide">
                      <label htmlFor="rec-camera">Camera</label>
                      <select id="rec-camera" value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                        <option value="">Default camera</option>
                        {cameras.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field wide">
                      <label htmlFor="rec-camera-res">Resolution</label>
                      <select id="rec-camera-res" value={webcamResolution} onChange={(e) => setWebcamResolution(e.target.value)}>
                        {WEBCAM_RESOLUTIONS.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {webcam && (
                  <label className="check">
                    <input type="checkbox" checked={webcamPip} onChange={(e) => setWebcamPip(e.target.checked)} />
                    Show it as a small picture in the lower right
                  </label>
                )}
              </fieldset>

              <fieldset className="options record-group">
                <legend>Start and stop</legend>
                <div className="record-row">
                  <div className="field wide">
                    <label htmlFor="rec-countdown">Countdown</label>
                    <select id="rec-countdown" value={countdown} onChange={(e) => setCountdown(Number(e.target.value) as CountdownSeconds)}>
                      {COUNTDOWN_CHOICES.map((c) => (
                        <option key={c} value={c}>
                          {c === 0 ? 'None' : `${c} seconds`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field wide">
                    <label htmlFor="rec-max">Maximum length (minutes, empty for none)</label>
                    <input id="rec-max" type="number" min="0" step="any" inputMode="decimal" value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} />
                  </div>
                </div>
                <label className="check">
                  <input type="checkbox" checked={toDisk} onChange={(e) => setToDisk(e.target.checked)} />
                  Save to disk while recording (keeps memory flat, and the footage survives a crash)
                </label>
                <label className="check">
                  <input type="checkbox" checked={addToTimeline} onChange={(e) => setAddToTimeline(e.target.checked)} />
                  Add the recording to the end of the timeline
                </label>
              </fieldset>
              <HotkeysPanel armFirst={armFirst} onArmFirst={setArmFirst} />
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="modal-actions">
              {unsaved && (
                <button className="button" onClick={() => download(unsaved, unsaved.name)}>
                  Save recording file
                </button>
              )}
              <button className="button" onClick={onClose}>
                Cancel
              </button>
              <button className="button primary" data-autofocus disabled={starting} onClick={() => void start()}>
                <Icon name="record" size={16} />
                {starting ? 'Starting…' : 'Start recording'}
              </button>
            </div>
          </>
        )}

        {phase === 'region' && still && region && (
          <>
            <div className="record-body">
              <RegionPicker still={still.url} bounds={still} canvas={editor.project} rect={region} onChange={setRegion} />
            </div>
            <div className="modal-actions">
              <button className="button" onClick={() => abandon()}>
                Cancel
              </button>
              <button className="button primary" data-autofocus onClick={confirmRegion}>
                {countdown > 0 ? 'Use region and count down' : 'Use region and record'}
              </button>
            </div>
          </>
        )}

        {phase === 'armed' && (
          <>
            <div className="rec-status armed" role="status">
              <span className="rec-dot" aria-hidden />
              <span>Ready. Nothing is recorded yet.</span>
            </div>
            <p className="modal-text">
              The screen is shared.{' '}
              {keysLive ? `Press ${keysLive['start-stop']} in any program, or click Start now, to begin.` : 'Click Start now to begin.'} You can switch to another window or minimise Capstan first.
            </p>
            <div className="modal-actions">
              <button className="button" data-autofocus onClick={() => abandon()}>
                Cancel
              </button>
              <button className="button primary" onClick={() => startCountdown()}>
                <Icon name="record" size={16} />
                Start now
              </button>
            </div>
          </>
        )}

        {phase === 'countdown' && (
          <>
            <div className="countdown" role="timer" aria-live="assertive" aria-atomic="true">
              <span className="countdown-label">Recording starts in</span>
              <span className="countdown-number">{count}</span>
            </div>
            <p className="modal-text">Get your screen ready. The browser’s sharing bar stays on while you wait.</p>
            <div className="modal-actions">
              <button className="button" data-autofocus onClick={() => abandon()}>
                Cancel
              </button>
            </div>
          </>
        )}

        {(phase === 'recording' || phase === 'paused' || phase === 'saving') && (
          <>
            <div className={`rec-status ${phase}`}>
              <span className="rec-dot" aria-hidden />
              <span className="rec-time">{timecode(elapsed)}</span>
              <span>{phase === 'paused' ? 'Paused' : phase === 'saving' ? 'Saving…' : 'Recording'}</span>
              {capturing && phase !== 'saving' && (
                <span className="rec-capture" role="status" data-testid="capture-indicator">
                  {captureLabel(capturing.keys, phase === 'paused')}
                </span>
              )}
            </div>
            {notice && phase !== 'saving' && (
              <p className="record-warning" role="status">
                {notice}
              </p>
            )}
            {limit.warn && phase === 'recording' && (
              <p className="record-warning" role="status">
                Recording stops and saves in {Math.ceil(limit.remaining ?? 0)} s (maximum length reached).
              </p>
            )}
            {maxSeconds > 0 && !limit.warn && phase !== 'saving' && <p className="hint record-meta">Stops automatically at {timecode(maxSeconds)}.</p>}
            {diskBytes !== null && phase !== 'saving' && (
              <p className="hint record-meta" data-testid="disk-status">
                Writing to disk as you record: {mb(diskBytes)} saved.
              </p>
            )}
            {flash && phase !== 'saving' && (
              <p className="record-flash" role="status" data-testid="marker-flash">
                {flash}
              </p>
            )}
            {keysLive && phase !== 'saving' && <p className="hint record-meta">{hotkeyHint(keysLive)}</p>}
            <p className="modal-text">Switch to what you want to record. Come back here, use the hotkeys, or use the browser’s “Stop sharing” bar, to finish.</p>
            <div className="modal-actions">
              {phase === 'recording' && (
                <button
                  className="button"
                  onClick={() => {
                    recorder.current?.pause();
                    void capture.current?.client.pause();
                    setPhase('paused');
                  }}
                >
                  Pause
                </button>
              )}
              {phase === 'paused' && (
                <button
                  className="button"
                  onClick={() => {
                    recorder.current?.resume();
                    void capture.current?.client.resume();
                    setPhase('recording');
                  }}
                >
                  Resume
                </button>
              )}
              <button className="button primary" disabled={phase === 'saving'} onClick={() => void finish()}>
                Stop and save
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
