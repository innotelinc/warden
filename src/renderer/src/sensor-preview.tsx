import { useCallback, useEffect, useRef, useState } from 'react'
import { cameraPlan, voicePlan, type CameraMode, type VoiceMode } from '@shared/sensors'
import { drawCameraFrame } from '@shared/camera-draw'

/**
 * Live camera and microphone test.
 *
 * Choosing a treatment from a dropdown is guesswork: "portrait blur" does not
 * tell you whether it hides the room behind you, and "synthetic" does not tell
 * you whether your voice is still intelligible. This runs the same code a page
 * gets — `drawCameraFrame` is the function the injected shim embeds, and the
 * audio graph is built from the same `voicePlan` numbers — so the preview is the
 * treatment, not an impression of it.
 *
 * Everything stays in this window: the stream is captured here, drawn here and
 * played back here. Nothing is recorded, uploaded or written to disk, and it all
 * stops when you leave the page or press stop.
 */

interface Props {
  cameraMode: CameraMode
  cameraStrength: number
  voiceMode: VoiceMode
  cameraBlocked: boolean
  microphoneBlocked: boolean
}

interface AudioChain {
  context: AudioContext
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  nodes: AudioNode[]
}

/** The page's audio graph, built from the same plan the shim uses. */
function buildVoiceChain(
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  analyser: AnalyserNode,
  mode: VoiceMode,
  monitor: boolean
): AudioNode[] {
  const plan = voicePlan(mode)
  const nodes: AudioNode[] = []
  let node: AudioNode = source

  const connect = (next: AudioNode): void => {
    node.connect(next)
    nodes.push(next)
    node = next
  }

  if (plan.lowpass) {
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = plan.lowpass
    connect(filter)
  }
  if (plan.highpass) {
    const filter = context.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = plan.highpass
    connect(filter)
  }
  if (plan.ringHz) {
    const ring = context.createGain()
    ring.gain.value = 1 - plan.ringDepth
    const osc = context.createOscillator()
    osc.frequency.value = plan.ringHz
    const depth = context.createGain()
    depth.gain.value = plan.ringDepth
    osc.connect(depth)
    depth.connect(ring.gain)
    osc.start()
    connect(ring)
    nodes.push(osc, depth)
  }

  node.connect(analyser)
  if (monitor) analyser.connect(context.destination)
  return nodes
}

function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError') return 'The camera or microphone was refused. Allow camera and microphone access for desktop apps in Windows privacy settings.'
  if (name === 'NotFoundError') return 'No camera or microphone was found on this machine.'
  if (name === 'NotReadableError') return 'The device is in use by another application.'
  if (name === 'OverconstrainedError') return 'The device cannot provide the requested resolution.'
  return error instanceof Error ? error.message : 'The test could not start.'
}

export function SensorPreview({ cameraMode, cameraStrength, voiceMode, cameraBlocked, microphoneBlocked }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const scratchRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef(0)
  const audioRef = useRef<AudioChain | null>(null)
  const planRef = useRef(cameraPlan(cameraMode, cameraStrength))
  const modeRef = useRef(cameraMode)
  const voiceRef = useRef(voiceMode)
  const monitorRef = useRef(true)

  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [monitor, setMonitor] = useState(true)

  planRef.current = cameraPlan(cameraMode, cameraStrength)
  modeRef.current = cameraMode
  voiceRef.current = voiceMode
  monitorRef.current = monitor

  const rebuildAudio = useCallback(() => {
    const chain = audioRef.current
    if (!chain) return
    for (const node of chain.nodes) {
      try {
        node.disconnect()
      } catch {
        /* already detached */
      }
    }
    try {
      chain.analyser.disconnect()
    } catch {
      /* already detached */
    }
    chain.nodes = buildVoiceChain(chain.context, chain.source, chain.analyser, voiceRef.current, monitorRef.current)
  }, [])

  // A different voice treatment, or monitoring on and off, rebuilds the graph
  // around the same live source. The capture itself is never restarted.
  useEffect(() => {
    if (audioRef.current) rebuildAudio()
  }, [voiceMode, monitor, rebuildAudio])

  const stop = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    const chain = audioRef.current
    audioRef.current = null
    if (chain) {
      for (const node of chain.nodes) {
        try {
          node.disconnect()
        } catch {
          /* already detached */
        }
      }
      try {
        chain.analyser.disconnect()
      } catch {
        /* already detached */
      }
      void chain.context.close().catch(() => undefined)
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
    setRunning(false)
    setLevel(0)
  }, [])

  const start = useCallback(async () => {
    setError(null)
    if (cameraBlocked && microphoneBlocked) {
      setError('Camera and microphone are both blocked in Policy above. Unblock one to run a test.')
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: cameraBlocked ? false : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: !microphoneBlocked
      })
    } catch (failure) {
      setError(describeError(failure))
      return
    }

    streamRef.current = stream
    const video = videoRef.current
    if (video) {
      video.srcObject = stream
      await video.play().catch(() => undefined)
    }
    if (!scratchRef.current) scratchRef.current = document.createElement('canvas')

    if (!microphoneBlocked) {
      const AudioCtor =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AudioCtor && stream.getAudioTracks().length) {
        const context = new AudioCtor()
        const source = context.createMediaStreamSource(stream)
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        audioRef.current = { context, source, analyser, nodes: [] }
        rebuildAudio()
      }
    }

    setRunning(true)

    const buffer = new Float32Array(1024)
    let tick = 0
    const render = (): void => {
      tick += 1
      const canvas = canvasRef.current
      const element = videoRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx && element) {
        const w = element.videoWidth
        const h = element.videoHeight
        if (w && h) {
          if (modeRef.current === 'off' || !scratchRef.current) {
            if (canvas.width !== w || canvas.height !== h) {
              canvas.width = w
              canvas.height = h
            }
            ctx.drawImage(element, 0, 0, w, h)
          } else {
            const scratchCtx = scratchRef.current.getContext('2d')
            if (scratchCtx) {
              drawCameraFrame(ctx, element, planRef.current, { canvas: scratchRef.current, ctx: scratchCtx })
            }
          }
        }
      }
      const chain = audioRef.current
      // Ten level updates a second is plenty for a meter and keeps React out of
      // the frame loop.
      if (chain && tick % 6 === 0) {
        chain.analyser.getFloatTimeDomainData(buffer)
        let sum = 0
        for (let i = 0; i < buffer.length; i += 1) {
          const sample = buffer[i] ?? 0
          sum += sample * sample
        }
        setLevel(Math.min(100, Math.round(Math.sqrt(sum / buffer.length) * 380)))
      }
      frameRef.current = requestAnimationFrame(render)
    }
    frameRef.current = requestAnimationFrame(render)
  }, [cameraBlocked, microphoneBlocked, rebuildAudio])

  useEffect(() => () => stop(), [stop])

  return (
    <div className="sensor-preview">
      <div className="sensor-stage">
        <video ref={videoRef} playsInline muted />
        <canvas ref={canvasRef} />
        {!running ? (
          <div className="sensor-idle">
            {cameraBlocked
              ? 'Camera is blocked in Policy above — the microphone test still runs'
              : 'Camera off — start a test to preview the treatment'}
          </div>
        ) : null}
      </div>
      <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
        {running ? (
          <button className="btn sm" onClick={stop}>
            stop test
          </button>
        ) : (
          <button className="btn sm primary" onClick={() => void start()}>
            start camera &amp; mic test
          </button>
        )}
        <label className="faint tiny" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={monitor} onChange={(event) => setMonitor(event.target.checked)} />
          hear the treated voice — use headphones
        </label>
      </div>
      <div className="sensor-meter" title={`microphone level ${level}%`} aria-hidden>
        <i style={{ width: `${level}%` }} />
      </div>
      <div className="faint tiny" style={{ marginTop: 6, lineHeight: 1.6 }}>
        {error ? (
          <span style={{ color: 'var(--danger)' }}>{error}</span>
        ) : (
          <>
            Showing <strong>{cameraMode}</strong> with voice <strong>{voiceMode}</strong>. Changing either above updates this
            live; the stream is captured, drawn and played inside this window only and stops when you leave this page.
          </>
        )}
      </div>
    </div>
  )
}
