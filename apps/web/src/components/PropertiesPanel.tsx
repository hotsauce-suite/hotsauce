import { parseFrontmatter } from '@hearth/format'
import { propertyList } from '../lib/format'
import { SidePanel } from './SidePanel'

/** Frontmatter as fields. Read-only here; edits happen in the source, so YAML is never rewritten. */
export function PropertiesPanel({
  text,
  onEditSource,
  onClose,
}: {
  text: string
  onEditSource: () => void
  onClose: () => void
}) {
  const { data, yamlText } = parseFrontmatter(text)
  const properties = propertyList(data)

  return (
    <SidePanel title="Properties" onClose={onClose}>
      <div className="p-4">
        {properties.length === 0 ? (
          <p className="text-sm text-ink-faint">
            No properties yet. Add YAML frontmatter at the top of the doc to set some.
          </p>
        ) : (
          <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-4 gap-y-2.5 text-sm">
            {properties.map((property) => (
              <div key={property.key} className="contents">
                <dt className="text-ink-faint">{property.key}</dt>
                <dd className="min-w-0 break-words text-ink">
                  {Array.isArray(property.value) ? (
                    <span className="flex flex-wrap gap-1">
                      {property.value.map((item) => (
                        <span key={item} className="rounded-full bg-paper-sunk px-2 py-0.5 text-xs">
                          {item}
                        </span>
                      ))}
                    </span>
                  ) : (
                    property.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {yamlText === null ? null : (
          <button
            type="button"
            onClick={onEditSource}
            className="mt-5 rounded-lg border border-ash px-3 py-1.5 text-sm text-ink hover:border-ember"
          >
            Edit in the doc
          </button>
        )}
      </div>
    </SidePanel>
  )
}
