/**
 * Seed a throwaway pgvector DB from the committed corpus using the REAL ingest
 * path (extract → chunk → embed → persist with embeddingVec). Measuring the
 * real retrieval means seeding through the real writer, not a shortcut.
 */
import { ingestKnowledgeFile } from '@/lib/knowledge/ingest'
import { corpusDocIds, corpusDocText } from './index'

/** Ingest every corpus doc as agent knowledge under the given org/agent. Returns the doc count. */
export async function seedCorpus(organizationId: string, agentId: string): Promise<number> {
  const ids = corpusDocIds()
  for (const docId of ids) {
    const text = corpusDocText(docId)
    await ingestKnowledgeFile({
      organizationId,
      agentId,
      userId: null,
      filename: `${docId}.md`,
      mimeType: 'text/markdown',
      buffer: Buffer.from(text, 'utf-8'),
    })
  }
  return ids.length
}
