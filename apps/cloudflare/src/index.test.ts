import { Container } from '@cloudflare/containers'
import { describe, expect, it } from 'vitest'
import { STATE_HOST } from './container-env.js'
import * as worker from './index.js'

describe('the Worker module (R10)', () => {
  it('registers the state host where the library looks for it', () => {
    // The base class's static getter reads the library's registry, which is what its
    // ContainerProxy consults; a class field would shadow it and leave the registry empty.
    const read = Object.getOwnPropertyDescriptor(Container, 'outboundByHost')?.get
    const handlers = read?.call(worker.HotsauceServer) as Record<string, unknown> | undefined
    expect(Object.keys(handlers ?? {})).toEqual([STATE_HOST])
    expect(Object.getOwnPropertyDescriptor(worker.HotsauceServer, 'outboundByHost')).toBeUndefined()
  })

  it('exports ContainerProxy, which the library needs to intercept outbound requests', () => {
    expect(worker.ContainerProxy).toBeTypeOf('function')
  })
})
