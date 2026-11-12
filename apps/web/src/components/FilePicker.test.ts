import { describe, expect, it, vi } from 'vitest'
import type { DriveFile } from '../api/files'
import { filesApi } from '../api/files'
import { attachmentFor, attachmentsIn, withoutAttachmentLinks } from './FilePicker'

const ID = '01JA2Z8Q4M7V3K9R5T1XWYB6CD'

function file(over: Partial<DriveFile> = {}): DriveFile {
  return {
    id: ID,
    space: 'team',
    path: `files/${ID}.md`,
    name: 'Plan [v2].pdf',
    folder: '',
    size: 1,
    mime: 'application/pdf',
    sha256: 'a'.repeat(64),
    preview: 'pdf',
    createdAt: '',
    createdBy: 'a@b.c',
    updatedAt: '',
    textStatus: 'none',
    shareToken: null,
    blobOid: 'x',
    url: `/files/team/${ID}`,
    contentUrl: '',
    downloadUrl: '',
    shareUrl: null,
    ...over,
  }
}

describe('attachments', () => {
  it('links a team file by its page, escaping brackets in the name', async () => {
    const a = await attachmentFor(file(), 'team')
    expect(a.markdown).toBe(`[Plan \\[v2\\].pdf](/files/team/${ID})`)
    expect(attachmentsIn(`see ${a.markdown} and ${a.markdown}`)).toEqual([
      { name: 'Plan [v2].pdf', url: `/files/team/${ID}` },
    ])
    expect(withoutAttachmentLinks(`see ${a.markdown}`)).toBe('see Plan [v2].pdf')
  })

  it('shares a personal file going into a team page', async () => {
    const shared = file({
      space: 'alice',
      shareToken: 'tok_tok_tok_tok_1',
      shareUrl: '/files/s/tok_tok_tok_tok_1',
    })
    const spy = vi.spyOn(filesApi, 'share').mockResolvedValue(shared)
    const a = await attachmentFor(file({ space: 'alice', url: `/files/alice/${ID}` }), 'team')
    expect(spy).toHaveBeenCalledWith('alice', ID, true)
    expect(a.url).toBe('/files/s/tok_tok_tok_tok_1')
    expect(attachmentsIn(a.markdown)[0]?.url).toBe(a.url)
    spy.mockRestore()
  })

  it('keeps a personal file’s own link inside the same personal space', async () => {
    const a = await attachmentFor(file({ space: 'alice', url: `/files/alice/${ID}` }), 'alice')
    expect(a.url).toBe(`/files/alice/${ID}`)
  })

  it('ignores links that aren’t Hearth files', () => {
    expect(attachmentsIn('[x](https://example.com) [y](/files/team/nope)')).toEqual([])
  })
})
