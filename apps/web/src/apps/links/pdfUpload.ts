// A PDF from the member's computer into Links (docs/PLAN-links-pdfs.md R6): uploaded to Files
// (folder "Links") the way Files uploads, then saved as a link or put on one.

import { filesApi, uploadFile } from '../../api/files'
import { LINKS_FILES_FOLDER, type LinkView, linksApi } from '../../api/links'

/** The same limit the server keeps PDFs to. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024

/** Why this file can't be added, or null when it can. */
export function pdfProblem(file: File): string | null {
  const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  if (!pdf) return `${file.name} isn’t a PDF`
  if (file.size > MAX_PDF_BYTES) return `${file.name} is over 50 MB, too big to keep`
  if (file.size === 0) return `${file.name} is empty`
  return null
}

/** Uploads the PDF to the space's Files and saves it as a link. */
export async function addPdf(file: File, space: string): Promise<LinkView & { existing: boolean }> {
  const stored = await uploadFile(file, { space, folder: LINKS_FILES_FOLDER })
  return withCleanup(space, stored.id, () => linksApi.savePdf(space, stored.id))
}

/** Uploads the PDF to the link's space and puts it on the link. */
export async function attachPdf(file: File, link: Pick<LinkView, 'space' | 'id'>) {
  const stored = await uploadFile(file, { space: link.space, folder: LINKS_FILES_FOLDER })
  return withCleanup(link.space, stored.id, () =>
    linksApi.attachPdf(link.space, link.id, stored.id),
  )
}

/** When Links turns the upload down, the PDF it was for doesn't stay behind in Files. */
async function withCleanup<T>(space: string, id: string, save: () => Promise<T>): Promise<T> {
  try {
    return await save()
  } catch (err) {
    await filesApi.remove(space, id).catch(() => {})
    throw err
  }
}
