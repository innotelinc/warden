export interface DoubledEscape {
  line: number
  pattern: string
}

export function findDoubledEscapes(text: string): DoubledEscape[]
