import { describe, expect, it } from 'vitest'
import { KeyedMutex } from './mutex.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('KeyedMutex', () => {
  it('runs calls for the same key one at a time, in order', async () => {
    const mutex = new KeyedMutex()
    const events: string[] = []
    const task = (name: string) =>
      mutex.run('space', async () => {
        events.push(`${name}:start`)
        await tick()
        events.push(`${name}:end`)
      })
    await Promise.all([task('a'), task('b'), task('c')])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
  })

  it('lets different keys run concurrently', async () => {
    const mutex = new KeyedMutex()
    const events: string[] = []
    const task = (key: string) =>
      mutex.run(key, async () => {
        events.push(`${key}:start`)
        await tick()
        events.push(`${key}:end`)
      })
    await Promise.all([task('a'), task('b')])
    expect(events.slice(0, 2).sort()).toEqual(['a:start', 'b:start'])
  })

  it('releases the lock when the task throws', async () => {
    const mutex = new KeyedMutex()
    await expect(
      mutex.run('space', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(mutex.run('space', async () => 'next')).resolves.toBe('next')
  })
})
