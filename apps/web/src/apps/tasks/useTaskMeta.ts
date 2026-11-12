import { useCallback, useEffect, useState } from 'react'
import { type TaskPerson, type TaskProject, tasksApi } from '../../api/tasks'
import { useSession } from '../../state/session'
import { useTasksChanged } from './useTaskList'

let peopleCache: TaskPerson[] | null = null
let projectsCache: TaskProject[] | null = null

/** Forgets the cached people and projects (tests, sign-out). */
export function forgetTaskMeta(): void {
  peopleCache = null
  projectsCache = null
}

/** The members a task can be assigned to; loaded once a page load. */
export function usePeople(): TaskPerson[] {
  const [people, setPeople] = useState<TaskPerson[]>(peopleCache ?? [])
  useEffect(() => {
    if (peopleCache) return
    let live = true
    tasksApi.people().then(
      (list) => {
        if (!Array.isArray(list)) return
        peopleCache = list
        if (live) setPeople(list)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [])
  return people
}

/** Every project with a task, per space, with its open count; refetched on `tasks/` changes. */
export function useProjects(): TaskProject[] {
  const [projects, setProjects] = useState<TaskProject[]>(projectsCache ?? [])
  const load = useCallback(() => {
    tasksApi.projects().then(
      (list) => {
        if (!Array.isArray(list)) return
        projectsCache = list
        setProjects(list)
      },
      () => {},
    )
  }, [])
  useEffect(load, [load])
  useTasksChanged(load)
  return projects
}

/** The member's personal space and the team's, by name. */
export function useTaskSpaces(): { personal: string | null; team: string | null } {
  const { spaces } = useSession()
  return {
    personal: spaces.find((s) => s.kind === 'personal')?.name ?? null,
    team: spaces.find((s) => s.kind === 'team')?.name ?? null,
  }
}
