/**
 * RAG eval — public surface + filesystem loaders.
 *
 * The corpus is a set of committed synthetic Sales-AI markdown docs; the corpus
 * doc id is the filename without its extension. golden.json is the committed
 * synthetic Q/A set scored against them (bootstrap-seeded, regenerable via
 * generate.ts — see `npm run eval:rag:generate`).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { GoldenItem } from './types'

export * from './types'
export { recallAtK, reciprocalRank, mean, retrievalMetrics } from './metrics'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CORPUS_DIR = join(HERE, 'corpus')
export const GOLDEN_PATH = join(HERE, 'golden.json')

/** Corpus doc ids (filename without extension), sorted. */
export function corpusDocIds(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''))
    .sort()
}

/** Read one corpus doc's text by id. */
export function corpusDocText(docId: string): string {
  return readFileSync(join(CORPUS_DIR, `${docId}.md`), 'utf-8')
}

/** Parse the committed golden set. */
export function loadGolden(): GoldenItem[] {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as GoldenItem[]
}

/** Map a retrieved knowledge filename back to its corpus doc id. */
export function filenameToDocId(filename: string): string {
  return filename.replace(/\.md$/, '')
}
