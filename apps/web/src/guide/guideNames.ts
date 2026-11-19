// Each app's id and name for Command-K's "What is X?" rows, kept small so the everyday bundle
// doesn't carry Hotsauce 101's words and videos. appGuide.test.ts checks it matches apps.json.

export const GUIDE_NAMES: readonly { id: string; name: string }[] = [
  { id: 'today', name: 'Today' },
  { id: 'for-you', name: 'For you' },
  { id: 'docs', name: 'Docs' },
  { id: 'meeting', name: 'Meetings' },
  { id: 'tasks', name: 'Tasks' },
  { id: 'dictate', name: 'Dictate' },
  { id: 'clips', name: 'Clips' },
  { id: 'assistant', name: 'Ask' },
  { id: 'notes', name: 'Notes' },
  { id: 'files', name: 'Files' },
  { id: 'tables', name: 'Tables' },
  { id: 'boards', name: 'Boards' },
  { id: 'people', name: 'People' },
  { id: 'briefcast', name: 'Daily briefing' },
  { id: 'booking', name: 'Booking links' },
  { id: 'forms', name: 'Forms' },
  { id: 'sign', name: 'Sign' },
  { id: 'checkins', name: 'Check-ins' },
  { id: 'links', name: 'Links' },
]
