import { describe, expect, it } from 'vitest'
import { apply, Config, name, TESTED_PEER_RANGE } from '../src/index.js'
import { createFakes } from './fakes.js'

function harness() {
  const fakes = createFakes()
  const registered: { name: string }[] = []
  const effects: string[] = []
  const ctx = {
    get: (service: string) => (fakes.services as Record<string, unknown>)[service],
    tools: {
      register: (tool: { name: string }) => {
        registered.push(tool)
        return () => {}
      },
    },
    effect: (_setup: () => unknown, label: string) => {
      effects.push(label)
    },
  } as never
  return { fakes, registered, effects, ctx }
}

const config: Config = { bridgeRoot: '/ws', appName: 'modal-dsh-sandboxes', defaultImage: 'python:3.13' }

describe('plugin registration', () => {
  it('registers the seven modal_sandbox tools', () => {
    const { registered, ctx } = harness()
    apply(ctx, config)
    expect(registered.map((tool) => tool.name).sort()).toEqual([
      'modal_sandbox_create',
      'modal_sandbox_exec',
      'modal_sandbox_exec_wait',
      'modal_sandbox_info',
      'modal_sandbox_output',
      'modal_sandbox_set_credentials',
      'modal_sandbox_terminate',
    ])
  })

  it('registers teardown effects for the tools and the bridge', () => {
    const { effects, ctx } = harness()
    apply(ctx, config)
    expect(effects).toEqual(['modal-dsh: tools', 'modal-dsh: bridge'])
  })

  it('exports the plugin identity and peer range', () => {
    expect(name).toBe('modal-dsh')
    expect(TESTED_PEER_RANGE).toBe('^0.1.0-rc.6')
    expect(Config).toBeDefined()
  })

  it('fails loudly when the required services are not mounted', () => {
    const ctx = { get: () => undefined, tools: { register: () => () => {} }, effect: () => {} } as never
    expect(() => apply(ctx, config)).toThrow(/"fs" and "subprocess"/)
  })
})
