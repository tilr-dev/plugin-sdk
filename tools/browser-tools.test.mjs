import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserTools } from './browser-tools.mjs'

test('browser tools preserve native view/frame targeting and async JS arguments', async () => {
  const requests = []
  const tools = browserTools(async (request, options) => {
    requests.push({ request, options })
    return { value: 42 }
  }, '/tmp/test.sock')
  const run = (name, args) => tools.find(t => t.name === `tilr_browser_${name}`).run(args)
  assert.deepEqual(
    await run('evaluate', {
      browser: 'view',
      app: 'work',
      frame: 'cross-origin',
      js: 'return await fetch(args.url).then(r => r.json())',
      args: { url: '/api' },
    }),
    { value: 42 },
  )
  assert.deepEqual(requests[0], {
    request: {
      cmd: 'browser',
      action: 'evaluate',
      browser: 'view',
      app: 'work',
      frame: 'cross-origin',
      js: 'return await fetch(args.url).then(r => r.json())',
      args: { url: '/api' },
    },
    options: { socket: '/tmp/test.sock' },
  })
  await run('act', { browser: 'view', action: 'scroll', ref: 'document:1', frame: 'child', deltaX: -12, deltaY: 300 })
  assert.deepEqual(requests[1].request, {
    cmd: 'browser',
    action: 'scroll',
    browser: 'view',
    ref: 'document:1',
    frame: 'child',
    deltaX: -12,
    deltaY: 300,
  })
  await run('list', {})
  assert.deepEqual(requests[2].request, { cmd: 'browser', action: 'list' })
})

test('native failures reach the MCP error handler rather than reporting success', async () => {
  const tools = browserTools(async () => {
    throw new Error('stale frame')
  }, '/tmp/test.sock')
  await assert.rejects(
    tools
      .find(t => t.name === 'tilr_browser_act')
      .run({ browser: 'view', frame: 'gone', action: 'click', ref: 'old:1' }),
    /stale frame/,
  )
})
