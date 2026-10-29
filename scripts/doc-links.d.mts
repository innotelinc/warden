export interface DocLink {
  line: number
  target: string
  raw: string
  fragment: string
}

export interface UnresolvedLink extends DocLink {
  path: string
  kind: 'path' | 'anchor'
  resolved: string
  anchor: string
}

export function findLinksIn(source: string): DocLink[]

export function normaliseTarget(raw: string): string

export function fragmentOf(raw: string): string

export function isExternal(target: string): boolean

export function slugify(text: string): string

export function headingAnchorsIn(source: string): Set<string>

export function unresolvedLinksIn(input: {
  path: string
  text: string
  exists: (path: string) => boolean
  anchors?: (path: string) => Set<string> | null
}): UnresolvedLink[]
