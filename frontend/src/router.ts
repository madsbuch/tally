// Generouted, changes to this file will be overridden
/* eslint-disable */

import { components, hooks, utils } from '@generouted/react-router/client'

export type Path =
  | `/`
  | `/app/analytics`
  | `/app/autophagy`
  | `/app/config`
  | `/app/journal`
  | `/app/journal/:date`
  | `/app/new`
  | `/app/summary/:id`
  | `/get-started`

export type Params = {
  '/app/journal/:date': { date: string }
  '/app/summary/:id': { id: string }
}

export type ModalPath = never

export const { Link, Navigate } = components<Path, Params>()
export const { useModals, useNavigate, useParams } = hooks<Path, Params, ModalPath>()
export const { redirect } = utils<Path, Params>()
