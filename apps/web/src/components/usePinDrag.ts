import { type PointerEvent, useRef, useState } from 'react'

/**
 * Drag-to-reorder for a row of pinned apps, shared by the desktop launcher and the phone's Apps
 * sheet. Each item carries `data-pin-id`; a press becomes a drag once it moves a few pixels, the
 * order shown follows the pointer, and `onDrop` gets the new order when it's let go. A cancelled
 * touch (the page scrolled, a call came in) puts everything back.
 */
export function usePinDrag({
  enabled,
  ids,
  onDrop,
}: {
  enabled: boolean
  /** The pinned ids as saved, in order. */
  ids: readonly string[]
  onDrop: (next: string[]) => void
}) {
  // While a pinned app is dragged, the order shown; saved when it's dropped.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const drag = useRef<{
    id: string
    pointer: number
    x: number
    y: number
    moving: boolean
  } | null>(null)
  // A drag that moved an app ends in a click on it, which mustn't also unpin it.
  const dragged = useRef(false)

  const onPointerDown = (event: PointerEvent<HTMLElement>, id: string) => {
    if (!enabled || event.button !== 0) return
    drag.current = {
      id,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moving: false,
    }
    dragged.current = false
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const dragging = drag.current
    if (dragging?.pointer !== event.pointerId) return
    // Capture only once it moves, so a plain click still lands on the unpin button.
    if (!dragging.moving) {
      if (Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) < 5) return
      dragging.moving = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setDragOrder([...ids])
    }
    const over = document
      .elementFromPoint?.(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-pin-id]')?.dataset.pinId
    if (!over || over === dragging.id) return
    dragged.current = true
    setDragOrder((was) => {
      const next = [...(was ?? [])]
      const from = next.indexOf(dragging.id)
      const to = next.indexOf(over)
      if (from === -1 || to === -1) return was
      next.splice(to, 0, ...next.splice(from, 1))
      return next
    })
  }
  const onPointerEnd = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    drag.current = null
    const next = dragOrder
    setDragOrder(null)
    if (event.type === 'pointercancel') return
    if (next && next.join() !== ids.join()) onDrop(next)
  }

  return {
    /** The order to show: the dragged order while a drag is on, else null. */
    dragOrder,
    /** Spread on each pinned item. */
    itemProps: (id: string) => ({
      'data-pin-id': id,
      onPointerDown: (event: PointerEvent<HTMLElement>) => onPointerDown(event, id),
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    }),
    /** True once, right after a drag that moved something: the click that ends it is not a tap. */
    takeDragged: (): boolean => {
      const was = dragged.current
      dragged.current = false
      return was
    },
  }
}
