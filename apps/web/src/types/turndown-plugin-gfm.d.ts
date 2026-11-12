// Joplin's maintained fork of turndown-plugin-gfm (tables, strikethrough, task lists) has no types.
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  export const gfm: TurndownService.Plugin
}
