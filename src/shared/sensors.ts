/**
 * Camera and microphone treatment for pages.
 *
 * The transforms run in the page's main world around `getUserMedia`: WARDEN
 * hands the page a derived MediaStreamTrack and keeps the raw device track to
 * itself. All of it is local — a canvas and a Web Audio graph — so no frame or
 * sample is uploaded anywhere. These are the parts Policy and the injected
 * script must agree on, kept pure so they are testable.
 */

export type CameraMode = 'off' | 'soften' | 'portrait' | 'pixelate' | 'silhouette'
export type VoiceMode = 'off' | 'deep' | 'bright' | 'robot'

export interface SensorSettings {
  cameraMode: CameraMode
  /** 0-100; blur radius and pixel size scale from this. */
  cameraStrength: number
  voiceMode: VoiceMode
  /** Blocks getUserMedia entirely when the page asks; stronger than a filter. */
  cameraBlocked: boolean
  microphoneBlocked: boolean
}

export const CAMERA_MODES: { id: CameraMode; name: string; detail: string }[] = [
  { id: 'off', name: 'Passthrough', detail: 'Hand the page the camera untouched' },
  { id: 'soften', name: 'Soft focus', detail: 'Whole frame softened — hides detail, keeps the room' },
  { id: 'portrait', name: 'Portrait blur', detail: 'Sharp centre, blurred surroundings' },
  { id: 'pixelate', name: 'Pixelate', detail: 'Coarse blocks; nothing recognisable' },
  { id: 'silhouette', name: 'Silhouette', detail: 'Flat colour silhouette on a dark field' }
]

export const VOICE_MODES: { id: VoiceMode; name: string; detail: string }[] = [
  { id: 'off', name: 'Passthrough', detail: 'Untouched microphone' },
  { id: 'deep', name: 'Lower', detail: 'Rolls off the highs — muffled, harder to match' },
  { id: 'bright', name: 'Lighter', detail: 'Cuts the lows — thin and telephone-like' },
  { id: 'robot', name: 'Synthetic', detail: 'Ring-modulated into a machine voice' }
]

export interface VoicePlan {
  /** Low-pass corner; 0 leaves the highs alone. */
  lowpass: number
  /** High-pass corner; 0 leaves the lows alone. */
  highpass: number
  /** Ring modulation frequency in Hz; 0 disables the modulator. */
  ringHz: number
  /** 0-1 wet level for the ring modulator. */
  ringDepth: number
}

/**
 * Deliberately not a true pitch shifter: a live granular shifter in the page
 * world costs more than it is worth here. These are tone changes that make a
 * voice harder to recognise — lower, brighter, or synthetic — and the UI says
 * exactly that rather than promising a different speaker.
 */
export function voicePlan(mode: VoiceMode): VoicePlan {
  switch (mode) {
    case 'deep':
      return { lowpass: 780, highpass: 0, ringHz: 0, ringDepth: 0 }
    case 'bright':
      return { lowpass: 0, highpass: 520, ringHz: 0, ringDepth: 0 }
    case 'robot':
      return { lowpass: 0, highpass: 0, ringHz: 88, ringDepth: 0.85 }
    default:
      return { lowpass: 0, highpass: 0, ringHz: 0, ringDepth: 0 }
  }
}

export interface CameraPlan {
  mode: CameraMode
  /** Blur radius in CSS pixels for the soften/portrait washes. */
  blur: number
  /** Block size for pixelate. */
  block: number
  /** True when only the centre oval stays sharp. */
  vignette: boolean
}

export function cameraPlan(mode: CameraMode, strength: number): CameraPlan {
  const level = Math.min(100, Math.max(0, Math.round(strength)))
  return {
    mode,
    blur: Math.max(2, Math.round(level / 3.2)),
    block: Math.max(6, Math.round(level / 2.4)),
    vignette: mode === 'portrait'
  }
}

export function isCameraMode(value: unknown): value is CameraMode {
  return CAMERA_MODES.some((entry) => entry.id === value)
}

export function isVoiceMode(value: unknown): value is VoiceMode {
  return VOICE_MODES.some((entry) => entry.id === value)
}

/** True when the page gets a transformed track rather than the raw device. */
export function transformsCamera(settings: SensorSettings): boolean {
  return !settings.cameraBlocked && settings.cameraMode !== 'off'
}

export function transformsVoice(settings: SensorSettings): boolean {
  return !settings.microphoneBlocked && settings.voiceMode !== 'off'
}
