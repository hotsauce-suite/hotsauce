import { useRouteLoaderData } from 'react-router'
import type { Health } from '../api/types'
import { product } from '../brand/product'
import { ProductMark } from './Icon'

/** The organization's mark from its brand kit, or the default Hotsauce bottle. */
export function BrandMark({ className = 'size-6' }: { className?: string }) {
  const health = useRouteLoaderData('root') as Health | undefined
  const src = health?.brand?.markUrl
  if (!src) return <ProductMark className={className} />
  return <img src={src} alt={product()} className={`${className} object-contain`} />
}
