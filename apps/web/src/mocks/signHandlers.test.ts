import { describe, expect, it } from 'vitest'
import { filesApi } from '../api/files'
import { signApi, signLinkApi } from '../api/sign'

describe('mock Sign', () => {
  it('shows the seeded signed envelope, with its copies in Files', async () => {
    const { envelopes } = await signApi.list()
    expect(envelopes.map((e) => [e.title, e.status])).toEqual([
      ['Northwind pilot terms', 'sent'],
      ['Acme pilot one-pager, approved', 'completed'],
    ])
    const env = await signApi.get('ada', envelopes[1]?.id ?? '')
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

  it('sends to someone outside the team, who signs from their link', async () => {
    const listing = await filesApi.list('team', 'Pilot launch')
    const pdf = listing.files.find((f) => f.name === 'Acme pilot one-pager.pdf')
    if (!pdf) throw new Error('no seeded PDF')
    const draft = await signApi.create('team', pdf.id)
    const sig = (id: string, signer: string) => ({
      id,
      signer,
      type: 'signature' as const,
      page: 1,
      x: 0.1,
      y: 0.5,
      width: 0.3,
      height: 0.06,
      required: true,
    })
    const placed = await signApi.saveDraft('ada', draft.id, {
      title: 'Terms',
      blobOid: draft.blobOid,
      signers: [
        { id: 's1', name: 'Maya Lin', email: 'maya@northwind.example', order: 1, role: 'signer' },
        { id: 's2', name: 'Sam Ortiz', email: 'sam@northwind.example', order: 2, role: 'copy' },
      ],
      fields: [sig('f1', 's1')],
    })
    const sent = await signApi.send('ada', draft.id, placed.blobOid)
    expect(sent.status).toBe('sent')
    expect(sent.links).toHaveLength(1)
    const token = sent.links[0]?.url.split('/signing/')[1] ?? ''
    const opened = await signLinkApi.get(token)
    expect(opened).toMatchObject({ status: 'ready', sender: 'Ada Lovelace', title: 'Terms' })
    const done = await signLinkApi.sign(token, {
      consent: true,
      values: [{ field: 'f1', value: 'Maya Lin' }],
    })
    expect(done.status).toBe('completed')
    expect((await signApi.get('ada', draft.id)).status).toBe('completed')
    await signApi.remove('ada', draft.id)
  })

  it('corrects someone after sending and copies a finished envelope into a draft', async () => {
    const { envelopes } = await signApi.list()
    const out = envelopes.find((e) => e.status === 'sent')
    const done = envelopes.find((e) => e.status === 'completed')
    if (!out || !done) throw new Error('no seeded envelopes')
    const env = await signApi.get(out.space, out.id)
    const who = env.signerList.find((p) => p.status === 'pending' && p.role !== 'copy')
    if (!who) throw new Error('nobody pending')
    const fixed = await signApi.correct(out.space, out.id, who.id, {
      name: who.name,
      email: 'right.address@example.org',
    })
    expect(fixed.signerList.find((p) => p.id === who.id)?.email).toBe('right.address@example.org')
    expect(fixed.audit.at(-1)?.event).toBe('signer_corrected')

    const copy = await signApi.copy(done.space, done.id)
    expect(copy).toMatchObject({ status: 'draft', title: done.title })
    expect(copy.audit.map((a) => a.event)).toEqual(['copied'])
    expect(copy.fields.every((f) => f.value === undefined && f.image === undefined)).toBe(true)
    await signApi.remove(copy.space, copy.id)
  })
})
