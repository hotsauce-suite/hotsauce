/** A small team space: docs, a meeting, metadata, trash and an image. Paths match the space layout. */
export const teamCorpus: Record<string, string> = {
  'README.md': '# Team\n\nShared space for Acme.\n',
  '.hearth/space.yaml': 'name: "team"\nschema: 1\n',
  '.hearth/docs/FORMAT.md': '# Docs format\n\nThe roadmap file conventions live here.\n',
  // Title hit only: "roadmap" is in the frontmatter title, not the body.
  'docs/roadmap.md':
    '---\nid: 01JROADMAP0000000000000000\ntitle: Roadmap\ncreated: 2026-10-01\n---\n' +
    'Where we are going next year, quarter by quarter.\n',
  // Body hit only.
  'docs/hiring/plan.md':
    '# Hiring plan\n\nWe will hire two scientists. Timing follows the roadmap once funding lands.\n',
  'docs/loose-thoughts.md': 'Some loose thoughts without a heading, about plan B.\n',
  'meetings/2026/10/2026-10-07-standup.md':
    '---\nid: 01JSTANDUP0000000000000000\ntype: meeting\ntitle: Standup\ndate: 2026-10-07\n---\n' +
    '# Standup\n\nDiscussed the sequencer budget and the hiring plan.\n',
  'assets/2026/10/logo-01JLOGO00.png': 'not really a png',
  '.trash/2026-10-01/docs/old-roadmap.md': '# Old roadmap\n\nDeleted.\n',
}

/** A personal space with a word that appears nowhere in the team space. */
export const personalCorpus: Record<string, string> = {
  'docs/diary.md': '# Diary\n\nPrivate note about the zebrafish experiment and my plan.\n',
}
