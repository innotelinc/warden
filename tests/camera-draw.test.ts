import { describe, expect, it } from 'vitest'
import { drawCameraFrame, type CameraDrawPlan } from '../src/shared/camera-draw'
import { cameraPlan, voicePlan } from '../src/shared/sensors'
import { sensorScript } from '../src/main/privacy/sensor-script'

/** A recording stand-in for a canvas context and its board. */
function makeCtx() {
  const canvas = { width: 0, height: 0 }
  const calls: string[] = []
  const ctx = {
    canvas,
    calls,
    filter: 'none',
    imageSmoothingEnabled: true,
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => calls.push('beginPath'),
    ellipse: (...args: number[]) => calls.push(`ellipse:${args.map((value) => Math.round(value)).join(',')}`),
    clip: () => calls.push('clip'),
    drawImage: (source: unknown, ...args: number[]) => {
      const kind =
        source === canvas
          ? 'canvas'
          : source && 'videoWidth' in (source as object)
            ? 'video'
            : 'board'
      calls.push(`draw:${kind}:${args.map((value) => Math.round(value)).join(',')}`)
    },
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      calls.push('getImageData')
      const data = new Uint8ClampedArray(width * height * 4)
      // One bright pixel and one dark pixel so both silhouette branches run.
      data[0] = 255
      data[1] = 255
      data[2] = 255
      return { data }
    },
    putImageData: () => calls.push('putImageData')
  }
  return ctx
}

type Ctx = ReturnType<typeof makeCtx>

const video = { videoWidth: 640, videoHeight: 480 } as unknown as HTMLVideoElement

const plan = (mode: CameraDrawPlan['mode'], overrides: Partial<CameraDrawPlan> = {}): CameraDrawPlan => ({
  mode,
  blur: 17,
  block: 10,
  ...overrides
})

const draw = (main: Ctx, scratch: Ctx, mode: CameraDrawPlan['mode'], overrides: Partial<CameraDrawPlan> = {}) =>
  drawCameraFrame(main as never, video, plan(mode, overrides), { canvas: scratch.canvas, ctx: scratch as never })

describe('camera frame treatment', () => {
  it('does nothing until the source has dimensions', () => {
    const main = makeCtx()
    const scratch = makeCtx()
    drawCameraFrame(main as never, { videoWidth: 0, videoHeight: 0 } as never, plan('soften'), {
      canvas: scratch.canvas,
      ctx: scratch as never
    })
    expect(main.calls).toEqual([])
  })

  it('sizes the canvas to the frame and only redraws when it changes', () => {
    const main = makeCtx()
    const scratch = makeCtx()
    draw(main, scratch, 'soften')
    expect(main.canvas).toEqual({ width: 640, height: 480 })
    main.calls.length = 0
    draw(main, scratch, 'soften')
    expect(main.calls.filter((call) => call.startsWith('draw:'))).toHaveLength(1)
  })

  it('softens the whole frame and leaves the filter clean for the next pass', () => {
    const main = makeCtx()
    const scratch = makeCtx()
    draw(main, scratch, 'soften')
    expect(main.filter).toBe('none')
    expect(main.calls).toContain('draw:video:0,0,640,480')
  })

  it('keeps a sharp oval in portrait mode', () => {
    const main = makeCtx()
    const scratch = makeCtx()
    draw(main, scratch, 'portrait')
    expect(main.calls.filter((call) => call.startsWith('draw:video'))).toHaveLength(2)
    expect(main.calls).toContain('beginPath')
    expect(main.calls).toContain('clip')
    expect(main.calls).toContain('restore')
    expect(main.calls.find((call) => call.startsWith('ellipse:'))).toBe('ellipse:320,221,186,202,0,0,6')
  })

  it('pixelates through the small scratch board', () => {
    const main = makeCtx()
    const scratch = makeCtx()
    draw(main, scratch, 'pixelate')
    expect(scratch.canvas).toEqual({ width: 80, height: 60 })
    expect(scratch.calls).toContain('draw:video:0,0,80,60')
    expect(main.imageSmoothingEnabled).toBe(false)
    expect(main.calls.some((call) => call.startsWith('draw:board:'))).toBe(true)
  })

  it('flattens the frame to two tones in silhouette mode', () => {
    const main = makeCtx()
    const scratch = makeCtx()
    const pixels = { data: new Uint8ClampedArray(8) }
    pixels.data[0] = 250
    pixels.data[1] = 250
    pixels.data[2] = 250
    scratch.getImageData = () => pixels
    draw(main, scratch, 'silhouette')
    // Bright pixel takes the mint tone, the dark one the field colour.
    expect([pixels.data[0], pixels.data[1], pixels.data[2]]).toEqual([79, 227, 193])
    expect([pixels.data[4], pixels.data[5], pixels.data[6]]).toEqual([9, 13, 18])
    expect(scratch.calls).toContain('putImageData')
    expect(main.calls.some((call) => call.startsWith('draw:board:'))).toBe(true)
  })
})

describe('page shim and preview share one implementation', () => {
  const script = sensorScript({
    cameraMode: 'portrait',
    cameraStrength: 60,
    voiceMode: 'robot',
    cameraBlocked: false,
    microphoneBlocked: false
  })

  it('ships the shared frame function rather than a second copy', () => {
    expect(script).toContain('const drawCameraFrame =')
    expect(script).toContain('drawCameraFrame(ctx, video, cfg.plan')
    // The numbers come from the same plan the preview imports.
    const expected = cameraPlan('portrait', 60)
    expect(script).toContain(`"blur":${expected.blur}`)
  })

  it('still parses as JavaScript with the function embedded', () => {
    expect(() => new Function(script)).not.toThrow()
  })

  it('keeps the voice plan identical to what the preview builds', () => {
    const expected = voicePlan('robot')
    expect(script).toContain(`"ringHz":${expected.ringHz}`)
    expect(script).toContain(`"ringDepth":${expected.ringDepth}`)
  })
})
