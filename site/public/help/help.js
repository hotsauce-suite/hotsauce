// The help center at hotsauce.work/help: the topic list in the sidebar, next and previous links,
// the light/dark switch, and the search box on the help home page.
//
// To add a help page:
// 1. Copy any page in this folder (for example docs.html) to <slug>.html and change its title,
//    description, canonical link, data-page, h1, lede and body.
// 2. Add it to PAGES below, and add its card to index.html in the same group.
// 3. A feature that isn't released yet gets `soon: true` here, the "Coming in the next release"
//    note on its page and a "Coming soon" badge on its card. Remove all three when it ships.
// site/help.test.js checks that these agree.

const GROUPS = [
  ['start', 'Start here'],
  ['apps', 'The apps'],
  ['devices', 'Other devices and agents'],
  ['admin', 'For admins'],
]

const PAGES = [
  { slug: 'getting-started', title: 'Getting started', group: 'start' },
  {
    slug: 'install-app',
    title: 'Install it on your phone and computer',
    group: 'start',
    soon: true,
  },
  { slug: 'settings', title: 'Settings and notifications', group: 'start', soon: true },
  { slug: 'shortcuts', title: 'Keyboard shortcuts and Command-K', group: 'start' },
  { slug: 'assistant', title: 'Ask: the AI assistant', group: 'start', soon: true },
  { slug: 'today', title: 'Today', group: 'apps' },
  { slug: 'docs', title: 'Docs', group: 'apps' },
  { slug: 'meetings', title: 'Meetings', group: 'apps' },
  { slug: 'booking', title: 'Booking links', group: 'apps' },
  { slug: 'tasks', title: 'Tasks', group: 'apps' },
  { slug: 'notes', title: 'Notes', group: 'apps' },
  { slug: 'files', title: 'Files', group: 'apps' },
  { slug: 'whiteboard', title: 'Whiteboard', group: 'apps' },
  { slug: 'people', title: 'People', group: 'apps' },
  { slug: 'forms', title: 'Forms', group: 'apps' },
  { slug: 'tables', title: 'Tables', group: 'apps' },
  { slug: 'links', title: 'Links', group: 'apps' },
  { slug: 'checkins', title: 'Check-ins', group: 'apps' },
  { slug: 'clips', title: 'Clips', group: 'apps' },
  { slug: 'dictate', title: 'Dictate and voice notes', group: 'apps' },
  { slug: 'briefcast', title: 'Daily briefing', group: 'apps' },
  { slug: 'sharing', title: 'Share links and pages', group: 'apps' },
  { slug: 'mac-app', title: 'Mac app', group: 'devices' },
  { slug: 'chrome-extension', title: 'Chrome extension', group: 'devices' },
  { slug: 'agents', title: 'Connect Claude and other agents', group: 'devices' },
  { slug: 'admin', title: 'Run Hotsauce for your team', group: 'admin' },
  { slug: 'install', title: 'Install Hotsauce', group: 'admin' },
]

{
  const root = document.documentElement
  const systemDark = matchMedia('(prefers-color-scheme: dark)')
  const modeBtn = document.getElementById('mode')
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : systemDark.matches)
  const applyTheme = () => {
    const dark = isDark()
    modeBtn?.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode')
    for (const m of document.querySelectorAll('meta[name=theme-color]')) {
      m.content = dark ? '#101c1b' : '#fff4e2'
    }
  }
  modeBtn?.addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark'
    try {
      localStorage.setItem('theme', root.dataset.theme)
    } catch {}
    applyTheme()
  })
  systemDark.addEventListener('change', applyTheme)
  applyTheme()

  // The sidebar and the next and previous links on an article page
  const main = document.querySelector('main[data-page]')
  const nav = document.getElementById('help-nav')
  if (main && nav) {
    const here = main.dataset.page
    const link = (p) => {
      const a = document.createElement('a')
      a.href = `/help/${p.slug}`
      a.textContent = p.title
      if (p.soon) {
        const b = document.createElement('span')
        b.className = 'badge'
        b.textContent = 'Soon'
        a.append(' ', b)
      }
      return a
    }
    nav.replaceChildren()
    const home = document.createElement('a')
    home.href = '/help/'
    home.className = 'home'
    home.textContent = 'All help topics'
    nav.append(home)
    for (const [id, name] of GROUPS) {
      const h = document.createElement('p')
      h.className = 'grp'
      h.textContent = name
      const list = document.createElement('ul')
      for (const p of PAGES.filter((x) => x.group === id)) {
        const li = document.createElement('li')
        const a = link(p)
        if (p.slug === here) a.setAttribute('aria-current', 'page')
        li.append(a)
        list.append(li)
      }
      nav.append(h, list)
    }
    const i = PAGES.findIndex((p) => p.slug === here)
    const pager = document.getElementById('pager')
    if (pager && i >= 0) {
      for (const [p, cls, label] of [
        [PAGES[i - 1], 'prev', 'Previous'],
        [PAGES[i + 1], 'next', 'Next'],
      ]) {
        if (!p) continue
        const a = link(p)
        a.className = cls
        const small = document.createElement('small')
        small.textContent = label
        a.prepend(small)
        pager.append(a)
      }
    }
  }

  // Search on the help home page: hide cards that don't match every word typed
  const search = document.getElementById('help-search')
  if (search) {
    const cards = [...document.querySelectorAll('.cards li')]
    const none = document.getElementById('help-none')
    search.addEventListener('input', () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean)
      let shown = 0
      for (const li of cards) {
        const text = `${li.textContent} ${li.dataset.k ?? ''}`.toLowerCase()
        const hit = words.every((w) => text.includes(w))
        li.hidden = !hit
        if (hit) shown++
      }
      for (const g of document.querySelectorAll('.group')) {
        g.hidden = !g.querySelector('.cards li:not([hidden])')
      }
      if (none) none.hidden = shown > 0
    })
  }
}
