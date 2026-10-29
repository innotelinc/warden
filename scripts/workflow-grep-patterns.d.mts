export interface DoubledEscape {
  line: number
  pattern: string
}

export interface DoubledEscapeFinding extends DoubledEscape {
  path: string
}

export interface ScannedFile {
  path: string
  text: string
}

export function findDoubledEscapes(text: string): DoubledEscape[]

export function findDoubledEscapesIn(files: ScannedFile[]): DoubledEscapeFinding[]
