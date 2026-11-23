import type { Slide } from '@hotsauce/format'
import { memo, type PointerEvent } from 'react'
import { BrandMark } from '../components/BrandMark'
import ReadingView, { type ResolveImage } from '../components/ReadingView'

/** Where the laser points, as fractions of the slide's width and height. */
export interface Point {
  x: number
  y: number
}

export interface SlideSource {
  space: string
  path: string
  resolveImage: ResolveImage
  personalSpace: string | null
}

/**
 * A slide's or its notes' Markdown. Memoized: the laser and the presenter's clock re-render the
 * show many times a second, and re-parsing Markdown each time would make the dot lag.
 */
export const SlideMarkdown = memo(function SlideMarkdown({
  markdown,
  space,
  path,
  resolveImage,
  personalSpace,
  className,
}: SlideSource & { markdown: string; className: string }) {
  return (
    <ReadingView
      markdown={markdown}
      space={space}
      path={path}
      resolveImage={resolveImage}
      personalSpace={personalSpace}
      embedded
      className={className}
    />
  )
})

/** A slide that opens with a `#` heading is a title slide. */
export const isTitleSlide = (slide: Slide) => /^# /.test(slide.body)

/** One 16:9 slide, fitted into the box it is given (docs/PLAN-slides.md). */
export function SlideFrame({
  slide,
  number,
  total,
  source,
  laser = null,
  onPoint,
  testId,
}: {
  slide: Slide
  number: number
  total: number
  source: SlideSource
  /** The laser's dot, when it is on. */
  laser?: Point | null
  /** Pointer moves over the slide, while the laser is on (null: it left). */
  onPoint?: ((point: Point | null) => void) | undefined
  testId?: string
}) {
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return
    onPoint?.({
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    })
  }
  const title = isTitleSlide(slide)
  return (
    <div className="slide-fit">
      <div
        className={`slide${title ? ' slide--title' : ''}${onPoint ? ' slide-laser-on' : ''}`}
        data-testid={testId}
        data-slide={number}
        {...(onPoint ? { onPointerMove: point, onPointerLeave: () => onPoint(null) } : {})}
      >
        <SlideMarkdown {...source} markdown={slide.body} className="slide-prose" />
        {title ? <BrandMark className="slide-mark" /> : null}
        <span className="slide-number" title={`Slide ${number} of ${total}`}>
          {number}
        </span>
        {laser ? (
          <span
            className="slide-laser"
            data-testid="slide-laser"
            style={{ left: `${laser.x * 100}%`, top: `${laser.y * 100}%` }}
          />
        ) : null}
      </div>
    </div>
  )
}
