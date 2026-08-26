import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { executeDispatchAssignment } from '@/lib/services/vpp.service'

export const POST = apiRoute<{ id: string }>(async (ctx, req, params) => {
  const id = params.id
  const body = (await readJsonBody(req)) as { provisioningSecret?: string }
  if (!body.provisioningSecret) {
    return { error: 'provisioningSecret is required' }
  }
  return executeDispatchAssignment(ctx.tenantId, id, body.provisioningSecret, ctx.actorId)
})
