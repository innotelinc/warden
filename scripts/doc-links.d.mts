export interface DocLink {
  line: number
  target: string
  raw: string
}

export interface UnresolvedLink extends DocLink {
  path: string
  resolved: string
}

export function findLinksIn(source: string): DocLink[]

export function normaliseTarget(raw: string): string

export function isExternal(target: string): boolean

export function unresolvedLinksIn(input: {
  path: string
  text: string
  exists: (path: string) => boolean
}): UnresolvedLink[]
