// Keeps the "Feedback" GitHub Project board and the feedback issues' labels in step
// (docs/plans/2026-11-12-feedback.md, R10). Runs in .github/workflows/feedback-board.yml through
// actions/github-script, with a token that can edit the organization's projects.
//
// Labels are the state the app and the daily review read (Claude sessions can't use GraphQL,
// which Projects needs). People move cards on the board; whichever changed last wins.

export const PROJECT_TITLE = 'Feedback'
export const FIELD_NAME = 'Feedback status'
export const COLUMNS = [
  { name: 'New', color: 'GRAY', description: 'Just sent; not reviewed yet' },
  {
    name: 'Needs info',
    color: 'YELLOW',
    description: 'Waiting for the sender to answer a question',
  },
  {
    name: 'Needs decision',
    color: 'ORANGE',
    description: 'Waiting for the owner: approve or decline',
  },
  { name: 'Approved', color: 'BLUE', description: 'Will be built' },
  { name: 'Building', color: 'PURPLE', description: 'A pull request is in progress' },
  { name: 'Shipped', color: 'GREEN', description: 'Live' },
  { name: 'Declined', color: 'RED', description: 'Not planned' },
]
const CLOSED = new Set(['shipped', 'declined'])

export const LABELS = [
  { name: 'feedback', color: 'd4c5f9', description: 'Sent from Send feedback in the app' },
  { name: 'bug', color: 'd73a4a', description: 'Something is broken' },
  { name: 'idea', color: 'a2eeef', description: 'A feature request' },
  ...COLUMNS.map((c) => ({
    name: statusLabel(c.name),
    color: 'ededed',
    description: c.description,
  })),
]

export function statusLabel(column) {
  return `status: ${column.toLowerCase()}`
}

/** The column an issue's labels say; closed without one reads as Shipped, open as New. */
export function columnOf(labels, state) {
  for (const c of COLUMNS) if (labels.includes(statusLabel(c.name))) return c.name
  return state === 'closed' ? 'Shipped' : 'New'
}

/**
 * What to do when the card and the labels disagree. Times are ISO strings or null.
 * Returns 'none', 'set-column' (labels win) or 'set-labels' (the board wins).
 */
export function decide({ column, columnUpdatedAt, labelColumn, labelUpdatedAt }) {
  if (column === labelColumn) return 'none'
  if (!column) return 'set-column'
  if (!labelUpdatedAt) return 'set-labels'
  if (!columnUpdatedAt) return 'set-column'
  return Date.parse(columnUpdatedAt) > Date.parse(labelUpdatedAt) ? 'set-labels' : 'set-column'
}

/** Entry point. `mode` is 'event' (an issue changed), 'sweep' (schedule) or 'setup'. */
export async function run({ github, context, core, mode, hasToken }) {
  const { owner, repo } = context.repo
  await ensureLabels(github, owner, repo, core)
  if (!hasToken) {
    core.notice('FEEDBACK_PROJECT_TOKEN is not set: labels are ready, the board is not synced.')
    return
  }
  let project = await findProject(github, owner)
  if (!project) {
    if (mode !== 'setup') {
      core.notice(
        `No "${PROJECT_TITLE}" project in ${owner} yet: run this workflow with mode setup.`,
      )
      return
    }
    project = await createProject(github, owner, repo)
    core.notice(`Created the ${PROJECT_TITLE} board: ${project.url}`)
  } else if (!project.field) {
    project.field = await createField(github, project.id)
  }
  core.setOutput('project_url', project.url)

  if (mode === 'event') {
    const issue = context.payload.issue
    if (!issue || !issue.labels.some((l) => l.name === 'feedback')) return
    // Only a change to the status itself moves the card. Any other label (or a reply) must not
    // overwrite a move the owner made on the board since; the sweep settles those by time.
    if (!statusChanged(context.payload)) return
    const itemId = await addItem(github, project.id, issue.node_id)
    await setColumn(
      github,
      project,
      itemId,
      columnOf(
        issue.labels.map((l) => l.name),
        issue.state,
      ),
    )
    return
  }

  // Sweep: put every feedback issue on the board, then settle each disagreement.
  const items = await listItems(github, project.id)
  const onBoard = new Set(items.map((i) => i.number))
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    labels: 'feedback',
    state: 'all',
    per_page: 100,
  })
  for (const issue of issues) {
    if (issue.pull_request || onBoard.has(issue.number)) continue
    const itemId = await addItem(github, project.id, issue.node_id)
    await setColumn(
      github,
      project,
      itemId,
      columnOf(
        issue.labels.map((l) => l.name),
        issue.state,
      ),
    )
  }
  for (const item of items) {
    if (item.repo !== `${owner}/${repo}` || !item.labels.includes('feedback')) continue
    const labelColumn = columnOf(item.labels, item.state)
    if (item.column === labelColumn) continue
    const labelUpdatedAt = await lastStatusLabelChange(github, owner, repo, item.number)
    const action = decide({
      column: item.column,
      columnUpdatedAt: item.columnUpdatedAt,
      labelColumn,
      labelUpdatedAt,
    })
    if (action === 'set-column') await setColumn(github, project, item.id, labelColumn)
    if (action === 'set-labels') await setLabels(github, owner, repo, item, item.column)
  }
}

/** Whether an issue event changed the item's status: opened, closed, reopened, or a status label. */
export function statusChanged(payload) {
  const action = payload.action
  if (action === 'opened' || action === 'closed' || action === 'reopened') return true
  if (action === 'labeled' || action === 'unlabeled') {
    const name = payload.label?.name ?? ''
    return name.startsWith('status: ') || name === 'feedback'
  }
  return false
}

async function ensureLabels(github, owner, repo, core) {
  const existing = new Set(
    (
      await github.paginate(github.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 })
    ).map((l) => l.name),
  )
  for (const label of LABELS) {
    if (existing.has(label.name)) continue
    await github.rest.issues.createLabel({ owner, repo, ...label })
    core.info(`Created label ${label.name}`)
  }
}

async function findProject(github, owner) {
  const data = await github.graphql(
    `query($owner: String!, $q: String!) {
      organization(login: $owner) {
        projectsV2(first: 20, query: $q) {
          nodes { id title url closed
            field(name: "${FIELD_NAME}") { ... on ProjectV2SingleSelectField { id options { id name } } }
          }
        }
      }
    }`,
    { owner, q: PROJECT_TITLE },
  )
  const node = data.organization.projectsV2.nodes.find(
    (p) => p.title === PROJECT_TITLE && !p.closed,
  )
  if (!node) return null
  return { id: node.id, url: node.url, field: node.field?.id ? node.field : null }
}

async function createProject(github, owner, repo) {
  const ids = await github.graphql(
    `query($owner: String!, $repo: String!) {
      organization(login: $owner) { id }
      repository(owner: $owner, name: $repo) { id }
    }`,
    { owner, repo },
  )
  const created = await github.graphql(
    `mutation($ownerId: ID!, $repositoryId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, repositoryId: $repositoryId, title: $title }) {
        projectV2 { id url }
      }
    }`,
    { ownerId: ids.organization.id, repositoryId: ids.repository.id, title: PROJECT_TITLE },
  )
  const project = created.createProjectV2.projectV2
  return { id: project.id, url: project.url, field: await createField(github, project.id) }
}

async function createField(github, projectId) {
  const data = await github.graphql(
    `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      createProjectV2Field(input: { projectId: $projectId, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options }) {
        projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } }
      }
    }`,
    { projectId, name: FIELD_NAME, options: COLUMNS },
  )
  return data.createProjectV2Field.projectV2Field
}

async function addItem(github, projectId, contentId) {
  const data = await github.graphql(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
    }`,
    { projectId, contentId },
  )
  return data.addProjectV2ItemById.item.id
}

async function setColumn(github, project, itemId, column) {
  const option = project.field.options.find((o) => o.name === column)
  if (!option) throw new Error(`The board has no "${column}" column`)
  await github.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) {
        projectV2Item { id }
      }
    }`,
    { projectId: project.id, itemId, fieldId: project.field.id, optionId: option.id },
  )
}

async function listItems(github, projectId) {
  const out = []
  let after = null
  for (let page = 0; page < 10; page++) {
    const data = await github.graphql(
      `query($projectId: ID!, $after: String) {
        node(id: $projectId) { ... on ProjectV2 {
          items(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id
              fieldValueByName(name: "${FIELD_NAME}") { ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt } }
              content { ... on Issue { number state repository { nameWithOwner } labels(first: 30) { nodes { name } } } }
            }
          }
        } }
      }`,
      { projectId, after },
    )
    const items = data.node.items
    for (const n of items.nodes) {
      if (!n.content?.number) continue
      out.push({
        id: n.id,
        number: n.content.number,
        state: n.content.state === 'CLOSED' ? 'closed' : 'open',
        repo: n.content.repository.nameWithOwner,
        labels: n.content.labels.nodes.map((l) => l.name),
        column: n.fieldValueByName?.name ?? null,
        columnUpdatedAt: n.fieldValueByName?.updatedAt ?? null,
      })
    }
    if (!items.pageInfo.hasNextPage) break
    after = items.pageInfo.endCursor
  }
  return out
}

async function lastStatusLabelChange(github, owner, repo, number) {
  const events = await github.paginate(github.rest.issues.listEvents, {
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  })
  const changes = events.filter(
    (e) =>
      ((e.event === 'labeled' || e.event === 'unlabeled') &&
        e.label?.name?.startsWith('status: ')) ||
      e.event === 'closed' ||
      e.event === 'reopened',
  )
  return changes.at(-1)?.created_at ?? null
}

async function setLabels(github, owner, repo, item, column) {
  for (const name of item.labels) {
    if (name.startsWith('status: ') && name !== statusLabel(column)) {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: item.number, name })
    }
  }
  await github.rest.issues.addLabels({
    owner,
    repo,
    issue_number: item.number,
    labels: [statusLabel(column)],
  })
  const shouldClose = CLOSED.has(column.toLowerCase())
  if (shouldClose !== (item.state === 'closed')) {
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: item.number,
      state: shouldClose ? 'closed' : 'open',
      ...(shouldClose ? { state_reason: column === 'Declined' ? 'not_planned' : 'completed' } : {}),
    })
  }
}
