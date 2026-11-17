import { describe, expect, it } from 'vitest'
import { filesApi } from '../api/files'
import { signApi } from '../api/sign'

describe('mock Sign', () => {
  it('shows the seeded signed envelope, with its copies in Files', async () => {
    const { envelopes } = await signApi.list()
    expect(envelopes.map((e) => [e.title, e.status])).toEqual([
      ['Acme pilot one-pager, approved', 'completed'],
    ])
    const env = await signApi.get('ada', envelopes[0]?.id ?? '')
    expect(env.audit.map((a) => a.event)).toEqual(['created', 'consented', 'signed', 'completed'])
    const listing = await filesApi.list('team', 'Pilot launch')
    expect(listing.files.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'Acme pilot one-pager (signed).pdf',
        'Acme pilot one-pager (certificate).pdf',
      ]),
    )
  })

  it('makes a draft from a PDF, places a signature, and signs it', async () => {
    const listing = await filesApi.list('team', 'Pilot launch')
    const pdf = listing.files.find((f) => f.name === 'Acme pilot one-pager.pdf')
    if (!pdf) throw new Error('no seeded PDF')
    const draft = await signApi.create('team', pdf.id)
    expect(draft).toMatchObject({ space: 'ada', status: 'draft', canSign: false })
    const placed = await signApi.saveDraft('ada', draft.id, {
      title: 'One-pager',
      blobOid: draft.blobOid,
      fields: [
        {
          id: 'f1',
          signer: 's1',
          type: 'signature',
          page: 1,
          x: 0.1,
          y: 0.8,
          width: 0.3,
          height: 0.06,
          required: true,
        },
      ],
    })
    expect(placed.canSign).toBe(true)
    expect((await signApi.source('ada', draft.id)).byteLength).toBeGreaterThan(100)
    const done = await signApi.sign('ada', draft.id, {
      values: [{ field: 'f1', value: 'Ada Lovelace' }],
      consent: true,
      blobOid: placed.blobOid,
    })
    expect(done.status).toBe('completed')
    expect(done.result?.signedFile).toBeTruthy()
    await signApi.remove('ada', draft.id)
  })
})
