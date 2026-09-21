import type { Params } from '../workflow/context'

export * from '../workflow'

interface Env extends CloudflareEnv {
  HACKER_PODCAST_WORKFLOW: Workflow<Params>
  BROWSER: Fetcher
}

const HOURLY_RECOVERY_CRON = '0 * * * *'
const ONE_DAY = 24 * 60 * 60 * 1000

async function createWorkflow(env: Env, options?: WorkflowInstanceCreateOptions<Params>) {
  const instance = await env.HACKER_PODCAST_WORKFLOW.create(options)

  const instanceDetails = {
    id: instance.id,
    details: await instance.status(),
  }

  console.info('instance detail:', instanceDetails)
  return instanceDetails
}

async function recoverYesterday(event: ScheduledEvent, env: Env): Promise<void> {
  const yesterday = new Date(event.scheduledTime - ONE_DAY).toISOString().split('T')[0]
  const runEnv = env.NODE_ENV || 'production'
  const key = `content:${runEnv}:hacker-podcast:${yesterday}`
  const existing = await env.HACKER_PODCAST_KV.get(key)

  if (existing) {
    console.info('yesterday article already exists:', { date: yesterday, key })
    return
  }

  const instanceId = `hacker-podcast-recovery-${yesterday}`
  try {
    await createWorkflow(env, { id: instanceId, params: { today: yesterday } })
  }
  catch {
    const instance = await env.HACKER_PODCAST_WORKFLOW.get(instanceId)
    const details = await instance.status()
    if (details.status === 'errored' || details.status === 'terminated' || details.status === 'complete') {
      await instance.restart()
      console.info('restart recovery workflow:', { id: instanceId, details })
    }
    else {
      console.info('recovery workflow already exists:', { id: instanceId, details })
    }
  }
}

export default {
  runWorkflow(event: ScheduledEvent | Request, env: Env, ctx: ExecutionContext) {
    console.info('trigger event by:', event)

    ctx.waitUntil(createWorkflow(env))

    return new Response('create workflow success')
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname, hostname } = new URL(request.url)
    if (request.method === 'POST' && hostname === 'localhost') {
      // curl -X POST http://localhost:8787
      return this.runWorkflow(request, env, ctx)
    }
    if (pathname.includes('/static')) {
      const filename = pathname.replace('/static/', '')
      const file = await env.HACKER_PODCAST_R2.get(filename)
      console.info('fetch static file:', filename, {
        uploaded: file?.uploaded,
        size: file?.size,
      })
      return new Response(file?.body)
    }
    return Response.redirect(`https://hacker-podcast.agi.li/${pathname}`, 302)
  },
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === HOURLY_RECOVERY_CRON) {
      ctx.waitUntil(recoverYesterday(event, env))
      return
    }
    return this.runWorkflow(event, env, ctx)
  },
}
