#!/usr/bin/env node
/**
 * Generates WARDEN's app icon without any image dependency.
 *
 * Draws the sigil (rounded graphite tile + mint shield frame) with 3x3
 * supersampling, encodes PNG chunks by hand, and packs multi-resolution ICO
 * entries. Windows accepts PNG-compressed ICO entries from Vista onward.
 */
import { deflateSync } from 'node:zlib'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'build')

const SHIELD = [
  [0.5, 0.155],
  [0.665, 0.215],
  [0.795, 0.272],
  [0.795, 0.5],
  [0.776, 0.567],
  [0.736, 0.646],
  [0.666, 0.722],
  [0.586, 0.788],
  [0.5, 0.848],
  [0.414, 0.788],
  [0.334, 0.722],
  [0.264, 0.646],
  [0.224, 0.567],
  [0.205, 0.5],
  [0.205, 0.272],
  [0.335, 0.215]
]

const INNER_SCALE = 0.62

function scalePolygon(points, scale, cx = 0.5, cy = 0.5) {
  return points.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale])
}

const SHIELD_INNER = scalePolygon(SHIELD, INNER_SCALE, 0.5, 0.505)

function insidePolygon(x, y, points) {
  let inside = false
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [xi, yi] = points[index]
    const [xj, yj] = points[previous]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false
  const clampX = Math.min(Math.max(x, left + radius), right - radius)
  const clampY = Math.min(Math.max(y, top + radius), bottom - radius)
  const dx = x - clampX
  const dy = y - clampY
  return dx * dx + dy * dy <= radius * radius
}

const lerp = (a, b, t) => a + (b - a) * t
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const clamp01 = (value) => Math.min(1, Math.max(0, value))

const BG_TOP = [17, 24, 32]
const BG_BOTTOM = [5, 8, 11]
const MINT_TOP = [124, 243, 216]
const MINT_BOTTOM = [26, 132, 114]
const INNER_TOP = [13, 20, 27]
const INNER_BOTTOM = [6, 10, 14]

function render(size) {
  const samples = 3
  const data = Buffer.alloc(size * size * 4)
  const margin = size * 0.015
  const radius = size * 0.235

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size
          const y = (py + (sy + 0.5) / samples) / size

          if (!insideRoundedRect(x * size, y * size, margin, margin, size - margin, size - margin, radius)) {
            continue
          }

          let color = mix(BG_TOP, BG_BOTTOM, clamp01((y - 0.06) / 0.9))

          // Soft mint glow behind the shield.
          const glowX = (x - 0.5) / 0.52
          const glowY = (y - 0.42) / 0.55
          const glow = Math.exp(-(glowX * glowX + glowY * glowY) * 1.7) * 0.22
          color = mix(color, [72, 214, 190], glow)

          if (insidePolygon(x, y, SHIELD)) {
            color = mix(MINT_TOP, MINT_BOTTOM, clamp01((y - 0.14) / 0.72))
            // Slight inner highlight at the top of the frame.
            color = mix(color, [220, 255, 247], Math.max(0, 0.18 - (y - 0.15) * 0.9))
          }
          if (insidePolygon(x, y, SHIELD_INNER)) {
            color = mix(INNER_TOP, INNER_BOTTOM, clamp01((y - 0.2) / 0.56))
            // A single mint spark inside the shielded area.
            const dotX = (x - 0.5) / 0.085
            const dotY = (y - 0.48) / 0.11
            const dot = Math.exp(-(dotX * dotX + dotY * dotY) * 1.6)
            color = mix(color, [79, 227, 193], clamp01(dot * 0.85))
          }

          r += color[0]
          g += color[1]
          b += color[2]
          a += 1
        }
      }

      const total = samples * samples
      const index = (py * size + px) * 4
      const coverage = a / total
      data[index] = coverage ? Math.round(r / a) : 0
      data[index + 1] = coverage ? Math.round(g / a) : 0
      data[index + 2] = coverage ? Math.round(b / a) : 0
      data[index + 3] = Math.round(coverage * 255)
    }
  }

  return data
}

// ------------------------------------------------------------------ PNG
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function chunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, payload])), 0)
  return Buffer.concat([length, typeBuffer, payload, crc])
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  let offset = 6 + entries.length * 16
  const directory = []
  for (const entry of entries) {
    const record = Buffer.alloc(16)
    record[0] = entry.size >= 256 ? 0 : entry.size
    record[1] = entry.size >= 256 ? 0 : entry.size
    record[2] = 0
    record[3] = 0
    record.writeUInt16LE(1, 4)
    record.writeUInt16LE(32, 6)
    record.writeUInt32LE(entry.png.length, 8)
    record.writeUInt32LE(offset, 12)
    directory.push(record)
    offset += entry.png.length
  }

  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.png)])
}

const sizes = [16, 24, 32, 48, 64, 128, 256]
const entries = sizes.map((size) => ({ size, png: encodePng(size, render(size)) }))

await fs.mkdir(buildDir, { recursive: true })
await fs.writeFile(path.join(buildDir, 'icon.ico'), encodeIco(entries))
await fs.writeFile(path.join(buildDir, 'icon.png'), encodePng(512, render(512)))
await fs.writeFile(path.join(buildDir, 'icon-256.png'), encodePng(256, render(256)))

const ico = await fs.stat(path.join(buildDir, 'icon.ico'))
const png = await fs.stat(path.join(buildDir, 'icon.png'))
console.log(`icon.ico  ${ico.size} bytes · ${sizes.join(', ')}`)
console.log(`icon.png  ${png.size} bytes · 512x512`)
