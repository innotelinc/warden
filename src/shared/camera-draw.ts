/**
 * One camera frame, treated.
 *
 * This is the only implementation of the video treatments: the page shim embeds
 * this function's source (`drawCameraFrame.toString()`) into the script it
 * injects, and the Settings preview imports it directly. The preview therefore
 * shows exactly what a page receives, and a change here cannot drift away from
 * what the operator is looking at.
 *
 * The parameter types are structural rather than DOM types on purpose: this
 * module is compiled for the main process too, where `lib.dom` is not in scope.
 */

export type CameraDrawMode = 'off' | 'soften' | 'portrait' | 'pixelate' | 'silhouette'

export interface CameraDrawPlan {
  mode: CameraDrawMode
  /** Blur radius in pixels for the soften and portrait passes. */
  blur: number
  /** Block size for pixelate. */
  block: number
}

interface Board {
  width: number
  height: number
}

interface FrameContext {
  canvas: Board
  filter: string
  imageSmoothingEnabled: boolean
  save(): void
  restore(): void
  beginPath(): void
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void
  clip(): void
  drawImage(source: unknown, ...args: number[]): void
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number
  ): { data: { [index: number]: number; length: number } }
  putImageData(data: unknown, x: number, y: number): void
}

interface FrameSource {
  videoWidth: number
  videoHeight: number
}

/**
 * Draw one treated frame into `ctx`.
 *
 * `scratch` is the low-resolution board the pixelate and silhouette passes need;
 * the caller owns it and this function resizes it as frames arrive, so a
 * resolution change mid-call is handled without reallocating a canvas per frame.
 */
export function drawCameraFrame(
  ctx: FrameContext,
  source: FrameSource,
  plan: CameraDrawPlan,
  scratch: { canvas: Board; ctx: FrameContext }
): void {
  const w = source.videoWidth
  const h = source.videoHeight
  if (!w || !h) return

  if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx.canvas.width = w
    ctx.canvas.height = h
  }

  const sw = Math.max(1, Math.round(w / 8))
  const sh = Math.max(1, Math.round(h / 8))

  if (plan.mode === 'pixelate') {
    if (scratch.canvas.width !== sw || scratch.canvas.height !== sh) {
      scratch.canvas.width = sw
      scratch.canvas.height = sh
    }
    scratch.ctx.drawImage(source, 0, 0, sw, sh)
    const blocks = Math.max(4, Math.round(sw / plan.block))
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(scratch.canvas, 0, 0, blocks, Math.round(blocks * (h / w)), 0, 0, w, h)
    return
  }

  if (plan.mode === 'silhouette') {
    if (scratch.canvas.width !== sw || scratch.canvas.height !== sh) {
      scratch.canvas.width = sw
      scratch.canvas.height = sh
    }
    scratch.ctx.drawImage(source, 0, 0, sw, sh)
    const data = scratch.ctx.getImageData(0, 0, sw, sh).data
    for (let i = 0; i < data.length; i += 4) {
      const luma = (data[i] ?? 0) * 0.299 + (data[i + 1] ?? 0) * 0.587 + (data[i + 2] ?? 0) * 0.114
      const on = luma > 74
      data[i] = on ? 79 : 9
      data[i + 1] = on ? 227 : 13
      data[i + 2] = on ? 193 : 18
      data[i + 3] = 255
    }
    scratch.ctx.putImageData({ data, width: sw, height: sh }, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(scratch.canvas, 0, 0, sw, sh, 0, 0, w, h)
    return
  }

  if (plan.mode === 'portrait') {
    ctx.filter = 'blur(' + plan.blur + 'px)'
    ctx.drawImage(source, 0, 0, w, h)
    ctx.filter = 'none'
    ctx.save()
    ctx.beginPath()
    ctx.ellipse(w / 2, h * 0.46, w * 0.29, h * 0.42, 0, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(source, 0, 0, w, h)
    ctx.restore()
    return
  }

  ctx.filter = 'blur(' + plan.blur + 'px)'
  ctx.drawImage(source, 0, 0, w, h)
  ctx.filter = 'none'
}
