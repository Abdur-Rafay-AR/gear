#!/usr/bin/env node
// Fixed production runner. Candidate resources are loaded through the host's native APIs.
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

/** One native implementation shared by fixed Docker profiles and the immutable Hitch carrier. */
export async function runNative(adapter, modelId, prompt, options = {}) {
  if (!['dsh', 'pi'].includes(adapter) || !modelId || !prompt) throw new Error('Expected adapter, model, task')
  const home = options.runtimeHome ?? (await mkdtemp(join(tmpdir(), 'gear-native-')))
  const target = options.target ?? (adapter === 'pi' ? process.env.PI_CODING_AGENT_DIR : process.env.DSH_HOME)
  const encoded = process.env.DSH_OPENAI_CODEX_ACCESS_B64
  if (!encoded) throw new Error('Missing DSH_OPENAI_CODEX_ACCESS_B64 credential reference')
  delete process.env.DSH_OPENAI_CODEX_ACCESS_B64
  const envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  if (envelope.version !== 1 || !envelope.access || !envelope.accountId || envelope.expires <= Date.now() + 300000)
    throw new Error('Credential envelope is invalid or expires within task deadline')
  const credential = {
    type: 'oauth',
    access: envelope.access,
    refresh: 'disabled-in-disposable-target',
    expires: envelope.expires,
    accountId: envelope.accountId,
  }
  if (adapter === 'pi') {
    const { AuthStorage, ModelRegistry, SettingsManager, DefaultResourceLoader, SessionManager, createAgentSession } =
      await import('@mariozechner/pi-coding-agent')
    const authStorage = AuthStorage.inMemory({ 'openai-codex': credential })
    const registry = ModelRegistry.create(authStorage)
    const base = registry.find('openai-codex', 'gpt-5.4')
    if (!base) throw new Error('Pinned Pi runtime has no Codex transport')
    const settings = target ? JSON.parse(await readFile(join(target, 'settings.json'), 'utf8')) : {}
    const settingsManager = SettingsManager.inMemory({ ...settings, retry: { enabled: false } })
    const resourceLoader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: target ?? home, settingsManager })
    await resourceLoader.reload()
    if (resourceLoader.getExtensions().errors.length) throw new Error('Native Pi extension failed to load')
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: target ?? home,
      authStorage,
      modelRegistry: registry,
      model: { ...base, id: modelId, name: modelId },
      thinkingLevel: 'low',
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
    })
    if (options.onEvent) session.subscribe(options.onEvent)
    try {
      await session.prompt(prompt)
      const message = session.messages.filter((m) => m.role === 'assistant').at(-1)
      if (!message || ['error', 'aborted'].includes(message.stopReason))
        throw new Error(`Native Pi request failed: ${message?.stopReason}`)
      const output = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      if (!options.onEvent) process.stdout.write(`${output}\n`)
    } finally {
      session.dispose()
    }
  } else {
    process.env.DSH_HOME = home
    process.env.DSH_TELEMETRY_DISABLED = '1'
    const profile = join(home, 'profiles/headless')
    await mkdir(profile, { recursive: true })
    await mkdir(join(home, 'profiles/node_modules'), { recursive: true })
    await symlink(join(root, 'node_modules/dsh-codex'), join(home, 'profiles/node_modules/dsh-codex'), 'dir')
    await writeFile(join(home, '.openai-codex-auth.json'), JSON.stringify({ version: 1, credential }), { mode: 0o600 })
    const patch = join(home, 'native.patch.json')
    await writeFile(
      patch,
      JSON.stringify([
        { id: 'hmr', disabled: false, config: { root: [] } },
        { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: process.cwd() } },
        { id: 'approval', config: { policy: 'never' } },
        {
          id: 'permission',
          config: {
            defaultPreset: 'danger-full-access',
            presets: { 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } },
          },
        },
        { id: 'agent-default-model', config: { provider: 'openai-codex', model: modelId } },
        { id: 'skill-filesystem', config: { customSkillDirs: target ? [join(target, 'skills')] : [] } },
        {
          insert: [
            { id: 'llm-openai-codex', name: 'dsh-codex' },
            {
              id: 'gear-native-policy',
              name: pathToFileURL(join(root, 'dsh-policy.mjs')).href,
              config: { model: modelId, target },
            },
          ],
        },
        { id: 'headless-runner', inject: ['headlessStartup', 'gearNativeTarget'] },
      ]),
    )
    process.argv = [
      process.execPath,
      join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      '--profile',
      'headless',
      '--patch',
      patch,
      '--',
      '--',
      prompt,
    ]
    await import('@deepseek-ai/dsh/lib/bin.js')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [adapter, model, prompt] = process.argv.slice(2)
  await runNative(adapter, model, prompt)
}
