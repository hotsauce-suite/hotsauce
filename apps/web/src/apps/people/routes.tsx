import type { RouteObject } from 'react-router'

const pages = () => import('./PeoplePages')

export const peopleRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await pages()).PeopleList }) },
  { path: 'company/:domain', lazy: async () => ({ Component: (await pages()).CompanyPage }) },
  { path: ':email', lazy: async () => ({ Component: (await pages()).PersonPage }) },
]
