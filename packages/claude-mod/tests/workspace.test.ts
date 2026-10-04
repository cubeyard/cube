// `claude plugin test packages/claude-mod`: the mod's hooks against the
// engine itself, with cubed's workspace routes answered in memory beneath
// `$.http.fetch`. No model is called.
import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const ROOT = '/srv/cube/threads/t1/claude'
const SOCKET = '/srv/cube/run/workspace.sock'
const BASE = '/api/threads/t1/workspace'
const TOKEN = 'a'.repeat(64)
const LIMITS = { maxFrameBytes: 1048576, requestTimeoutMs: 30000, maxCommandBytes: 65536, maxPathBytes: 4096, maxExecTimeoutMs: 600000, maxOutputBytes: 262144, outputPageBytes: 65536, maxReadBytes: 524288, maxWriteBytes: 524288 }

type Reply = { value: { status: number; ok: boolean; headers: Record<string, string>; text: string } }
type Request = { method: string; path: string; body: Record<string, unknown> | undefined; socketPath: string | undefined; authorization: string | undefined }

/** The routes cubed serves, in memory: files, keyed commands and writes. */
function fakeWorkspace(on: On, files: Record<string, string> = {}) {
  const requests: Request[] = []
  const operations = new Map<string, { request: string; reply: Reply }>()
  const shas = new Map<string, number>()
  const sha = (file: string) => `sha-${file}-${shas.get(file) ?? 0}`
  const reply = (status: number, body: unknown): Reply => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
  const fail = (status: number, code: string) => reply(status, { error: code.toLowerCase(), code, completionUnknown: false })
  mock.env(on, { CUBE_WORKSPACE_SOCKET: SOCKET, CUBE_WORKSPACE_PATH: BASE, CUBE_WORKSPACE_TOKEN: TOKEN, CUBE_WORKSPACE_ROOT: ROOT })
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    const body = e.init?.body === undefined ? undefined : JSON.parse(e.init.body) as Record<string, unknown>
    const request = { method: e.init?.method ?? 'GET', path: url.pathname, body, socketPath: e.init?.socketPath, authorization: e.init?.headers?.authorization }
    requests.push(request)
    if (!url.pathname.startsWith(BASE)) return fail(404, 'NOT_FOUND')
    const route = url.pathname.slice(BASE.length)
    if (route === '' && request.method === 'GET') return reply(200, { capabilities: [], limits: LIMITS })
    if (request.authorization !== `Bearer ${TOKEN}`) return fail(401, 'LEASE_STALE')
    const keyed = (key: string, describe: unknown, run: () => Reply): Reply => {
      const seen = operations.get(key)
      if (seen) return seen.request === JSON.stringify(describe) ? seen.reply : fail(409, 'CONFLICT')
      const result = run()
      operations.set(key, { request: JSON.stringify(describe), reply: result })
      return result
    }
    if (route === '/exec' && request.method === 'POST') {
      return keyed(String(body!.key), body, () => {
        const command = String(body!.command)
        const output = command === 'false' ? '' : `ran: ${command}\n`
        return reply(200, { key: body!.key, state: 'succeeded', exitCode: command === 'false' ? 1 : 0, termination: 'exited', output: btoa(output), outputOffset: 0, retainedBytes: output.length, outputBytes: output.length, truncated: false })
      })
    }
    if (route.startsWith('/operations/') && request.method === 'GET') {
      const seen = operations.get(decodeURIComponent(route.slice('/operations/'.length)))
      return seen ? seen.reply : fail(404, 'NOT_FOUND')
    }
    const file = url.searchParams.get('path') ?? String(body?.path)
    if (route === '/stat' && request.method === 'GET') {
      return file in files ? reply(200, { kind: 'file', size: files[file]!.length, mode: 0o644, modifiedMs: 0, sha256: sha(file) }) : fail(404, 'NOT_FOUND')
    }
    if (route === '/file' && request.method === 'GET') {
      if (!(file in files)) return fail(404, 'NOT_FOUND')
      return reply(200, { content: btoa(files[file]!), offset: 0, size: files[file]!.length, eof: true, sha256: sha(file) })
    }
    if (route === '/file' && request.method === 'PUT') {
      return keyed(String(body!.key), body, () => {
        if (body!.expectedSha !== undefined && body!.expectedSha !== sha(file)) return fail(412, 'PRECONDITION_FAILED')
        files[file] = atob(String(body!.content))
        shas.set(file, (shas.get(file) ?? 0) + 1)
        return reply(200, { sha256: sha(file), size: files[file]!.length })
      })
    }
    return fail(404, 'NOT_FOUND')
  })
  return { requests, files }
}

/** Beneath every plugin: a call the mod passes on reaches "the engine". */
/** The refusal text, whether the call came back denied or errored. */
function refusal(result: { deny?: string; isError?: true; text?: string }): string {
  return String(result.deny ?? (result.isError ? result.text : undefined))
}

function engine(on: On) {
  const reached: string[] = []
  on('tool.call', ($, e) => { reached.push(String(e.tool)); return { result: `engine ran ${String(e.tool)}` } })
  return reached
}

describe('workspace tools', () => {
  test('Bash runs on the runner under its tool_use_id, once', async ($, on) => {
    const workspace = fakeWorkspace(on)
    const reached = engine(on)
    const ran = await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(ran.result).toEqual({ stdout: 'ran: ls -la\n', stderr: '', interrupted: false })
    const failed = await $.tool.call({ tool: 'Bash', command: 'false' })
    expect(failed.result).toEqual({ stdout: '', stderr: 'exit code 1', interrupted: false })
    expect(reached).toEqual([])
    const exec = workspace.requests.filter(request => request.path === `${BASE}/exec`)
    expect(exec.length).toBe(2)
    for (const request of exec) {
      expect(request.socketPath).toBe(SOCKET)
      expect(String(request.body?.key)).toMatch(/^claude:.+:bash$/)
      expect(request.body?.timeoutMs).toBe(120000)
    }
    expect(exec[0]!.body?.key === exec[1]!.body?.key).toBe(false)
  })

  test('Read maps absolute paths onto the workspace and pages lines', async ($, on) => {
    fakeWorkspace(on, { 'src/a.txt': 'one\ntwo\nthree\n' })
    engine(on)
    const all = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/a.txt` })
    expect(all.result).toEqual({ type: 'text', file: { filePath: `${ROOT}/src/a.txt`, content: 'one\ntwo\nthree', numLines: 3, startLine: 1, totalLines: 3 } })
    const part = await $.tool.call({ tool: 'Read', file_path: '/workspace/src/a.txt', offset: 2, limit: 1 })
    expect(part.result).toEqual({ type: 'text', file: { filePath: '/workspace/src/a.txt', content: 'two', numLines: 1, startLine: 2, totalLines: 3 } })
    const outside = await $.tool.call({ tool: 'Read', file_path: '/etc/passwd' })
    expect(refusal(outside)).toMatch(/outside the thread workspace/)
    const escape = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/../secret` })
    expect(refusal(escape)).toMatch(/leaves the thread workspace/)
    const missing = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/nope` })
    expect(refusal(missing)).toMatch(/does not exist/)
  })

  test('Write creates, Edit replaces with the sha it read', async ($, on) => {
    const workspace = fakeWorkspace(on)
    engine(on)
    const created = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes/plan.md`, content: 'alpha beta alpha\n' })
    expect(created.result).toEqual({ type: 'create', filePath: `${ROOT}/notes/plan.md`, content: 'alpha beta alpha\n', structuredPatch: [], originalFile: null })
    expect(workspace.files['notes/plan.md']).toBe('alpha beta alpha\n')
    const ambiguous = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/notes/plan.md`, old_string: 'alpha', new_string: 'gamma' })
    expect(refusal(ambiguous)).toMatch(/Found 2 matches/)
    const edited = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/notes/plan.md`, old_string: 'beta', new_string: 'delta' })
    expect(edited.result).toEqual({ filePath: `${ROOT}/notes/plan.md`, oldString: 'beta', newString: 'delta', originalFile: 'alpha beta alpha\n', structuredPatch: [], userModified: false, replaceAll: false })
    expect(workspace.files['notes/plan.md']).toBe('alpha delta alpha\n')
    const put = workspace.requests.filter(request => request.method === 'PUT').at(-1)!
    expect(put.body?.expectedSha).toBe('sha-notes/plan.md-1')
    expect(String(put.body?.key)).toMatch(/^claude:.+:edit$/)
    const all = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/notes/plan.md`, old_string: 'alpha', new_string: 'omega', replace_all: true })
    expect(all.deny).toBe(undefined)
    expect(workspace.files['notes/plan.md']).toBe('omega delta omega\n')
    const absent = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/notes/plan.md`, old_string: 'zeta', new_string: 'eta' })
    expect(refusal(absent)).toMatch(/String to replace not found/)
  })

  test('host-local tools, background commands and isolated subagents are refused', async ($, on) => {
    const workspace = fakeWorkspace(on)
    const reached = engine(on)
    const background = await $.tool.call({ tool: 'Bash', command: 'sleep 100', run_in_background: true })
    expect(refusal(background)).toMatch(/background commands are not available/)
    const notebook = await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${ROOT}/a.ipynb`, new_source: 'x' })
    expect(refusal(notebook)).toMatch(/NotebookEdit is not available/)
    const worktree = await $.tool.call({ tool: 'EnterWorktree', name: 'x' })
    expect(refusal(worktree)).toMatch(/EnterWorktree is not available/)
    const isolated = await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'look around', isolation: 'worktree' })
    expect(refusal(isolated)).toMatch(/worktree isolation/)
    const remote = await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'look around', isolation: 'remote' })
    expect(refusal(remote)).toMatch(/remote isolation/)
    const plain = await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'look around' })
    expect(plain.result).toBe('engine ran Agent')
    expect(reached).toEqual(['Agent'])
    expect(workspace.requests.filter(request => request.method !== 'GET').length).toBe(0)
  })

  test('only allow-listed tools run: MCP and unknown tools are refused', async ($, on) => {
    const workspace = fakeWorkspace(on)
    const reached = engine(on)
    const mcp = await $.tool.call({ tool: 'mcp__github__create_issue', title: 'x' } as never)
    expect(refusal(mcp)).toMatch(/mcp__github__create_issue is not available/)
    const fetch = await $.tool.call({ tool: 'WebFetch', url: 'http://127.0.0.1:7777/api/state', prompt: 'read it' })
    expect(refusal(fetch)).toMatch(/WebFetch is not available/)
    const unknown = await $.tool.call({ tool: 'SomeFutureTool', path: '/' } as never)
    expect(refusal(unknown)).toMatch(/SomeFutureTool is not available/)
    const glob = await $.tool.call({ tool: 'Glob', pattern: '**/*' } as never)
    expect(refusal(glob)).toMatch(/Glob is not available/)
    const todo = await $.tool.call({ tool: 'TodoWrite', todos: [] })
    expect(todo.result).toBe('engine ran TodoWrite')
    expect(reached).toEqual(['TodoWrite'])
    expect(workspace.requests.filter(request => request.method !== 'GET').length).toBe(0)
  })

  test('subagents start only as built-in types without isolation', async ($, on) => {
    fakeWorkspace(on)
    const spawned: string[] = []
    on('agent.spawn', ($, e) => { spawned.push(e.subagentType); return { model: 'haiku', agentId: `agent-${spawned.length}` } })
    const builtin = await $.agent.spawn({ prompt: 'look around', description: 'look', subagentType: 'general-purpose' } as never)
    expect(builtin.deny).toBe(undefined)
    const isolated = await $.agent.spawn({ prompt: 'look around', description: 'look', subagentType: 'general-purpose', isolation: 'worktree' } as never)
    expect(String(isolated.deny)).toMatch(/worktree isolation/)
    expect(spawned).toEqual(['general-purpose'])
  })

  test('the workspace instructions join the first message context', async ($, on) => {
    fakeWorkspace(on, { 'AGENTS.md': '# Working on demo\nrun the tests\n' })
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    const context = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })
    expect(context.blocks.length).toBe(2)
    expect(context.blocks[0]!.name).toBe('currentDate')
    expect(context.blocks[1]!.name).toBe('cubeWorkspace')
    expect(context.blocks[1]!.text).toMatch(/run the tests/)
    expect(context.blocks[1]!.text).toMatch(/not a sandbox/)
  })
})

test('without a cube workspace the file and shell tools are refused', async ($, on) => {
  mock.env(on, {})
  const reached = engine(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(refusal(ran)).toMatch(/no thread workspace/)
  expect(reached).toEqual([])
})
