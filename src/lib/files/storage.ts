import { createClient } from '@supabase/supabase-js'
import { prisma } from '@/lib/prisma'

/**
 * Original-file storage for uploads (run-form file inputs and future step
 * outputs). Bytes go to Supabase Storage when the service-role key is
 * configured (prod); otherwise they live inline on the row (`backend: 'db'`)
 * — which is also what local dev and CI exercise. Reads dispatch on the
 * row's recorded backend, so environments can migrate without data moves.
 */

export const STORED_FILE_MAX_BYTES = 10_000_000
const BUCKET = 'stored-files'

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function saveStoredFile(params: {
  organizationId: string
  userId?: string | null
  filename: string
  mimeType: string
  buffer: Buffer
}): Promise<{ id: string; filename: string; mimeType: string; size: number }> {
  if (params.buffer.length > STORED_FILE_MAX_BYTES) {
    throw new Error(`Files can be at most ${Math.round(STORED_FILE_MAX_BYTES / 1_000_000)} MB.`)
  }
  const filename = params.filename.replace(/[\r\n]/g, ' ').slice(0, 200) || 'file'
  const supabase = supabaseAdmin()
  if (supabase) {
    const row = await prisma.storedFile.create({
      data: {
        organizationId: params.organizationId,
        userId: params.userId ?? null,
        filename,
        mimeType: params.mimeType,
        size: params.buffer.length,
        backend: 'supabase',
        storagePath: '',
      },
    })
    const storagePath = `${params.organizationId}/${row.id}`
    const uploaded = await supabase.storage.from(BUCKET).upload(storagePath, params.buffer, {
      contentType: params.mimeType,
      upsert: true,
    })
    if (uploaded.error) {
      // The row without bytes is useless — remove it so the caller's error
      // isn't followed by a phantom file in listings.
      await prisma.storedFile.delete({ where: { id: row.id, organizationId: params.organizationId } }).catch(() => {})
      throw new Error(`Could not store the file: ${uploaded.error.message}`)
    }
    await prisma.storedFile.update({ where: { id: row.id, organizationId: params.organizationId }, data: { storagePath } })
    return { id: row.id, filename, mimeType: params.mimeType, size: params.buffer.length }
  }
  const row = await prisma.storedFile.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId ?? null,
      filename,
      mimeType: params.mimeType,
      size: params.buffer.length,
      backend: 'db',
      data: params.buffer,
    },
  })
  return { id: row.id, filename, mimeType: params.mimeType, size: params.buffer.length }
}

export async function readStoredFile(
  id: string,
  organizationId: string,
): Promise<{ filename: string; mimeType: string; buffer: Buffer } | null> {
  const row = await prisma.storedFile.findFirst({ where: { id, organizationId } })
  if (!row) return null
  if (row.backend === 'supabase' && row.storagePath) {
    const supabase = supabaseAdmin()
    if (!supabase) return null
    const downloaded = await supabase.storage.from(BUCKET).download(row.storagePath)
    if (downloaded.error || !downloaded.data) return null
    return { filename: row.filename, mimeType: row.mimeType, buffer: Buffer.from(await downloaded.data.arrayBuffer()) }
  }
  if (!row.data) return null
  return { filename: row.filename, mimeType: row.mimeType, buffer: Buffer.from(row.data) }
}
