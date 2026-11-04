/**
 * Model Memory — Host half.
 *
 * Remembers the model selection that was in use when DSH last ran, and makes it
 * the deployment default again on the next start, so a freshly created session
 * opens on the same model the user left behind.
 *
 * Source of truth: durable session events of ordinary (user-owned) sessions —
 * `model/selection` records the intent for the next request, `request/header`
 * records what was actually used. The latest one wins and is appended to a small
 * JSON file under DSH_HOME, so it survives profile-patch edits and a missing
 * configuration editor.
 *
 * On activation the plugin compares that record with the live default and, when
 * it differs and its provider is still routable, writes it back through
 * `agentDefaultModel.saveSelection()` — the same path the built-in model
 * switcher uses.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Bundle-local state file name used under DSH_HOME. */
const STATE_FILE_NAME = 'model-memory.state.json'
/** Format version of the persisted record. */
const STATE_VERSION = 1
/** Delay that coalesces bursts of selection events into one write. */
const WRITE_DEBOUNCE_MS = 500

export const name = 'model-memory'

/**
 * Install the recorder and the one-shot startup restore.
 * @param ctx - Host context that owns the registrations.
 * @param config - Row config: `enabled`, `stateFile`, `trackSubagents`.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const trackSubagents = config.trackSubagents === true
  const stateFile = typeof config.stateFile === 'string' && config.stateFile.trim() !== ''
    ? config.stateFile
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), STATE_FILE_NAME)
  const logger = ctx.logger

  /** Remembered selection, or undefined before the state file is read. */
  let remembered
  /** Identity of the selection already written, to skip no-op writes. */
  let persistedKey
  /** Whether the startup restore has been attempted. */
  let restoreAttempted = false
  /** Pending debounce timer for the next write. */
  let timer
  /** Serialized write chain. */
  let writing = Promise.resolve()

  ctx.on('session/event', (session, event) => {
    if (!trackSubagents && isAgentOwnedSession(session)) return
    const candidate = selectionOf(event)
    if (candidate === undefined) return
    if (remembered !== undefined && sameSelection(remembered, candidate)) return
    remembered = candidate
    schedule()
  })

  ctx.effect(() => () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    flush()
  })

  ctx.inject(['agentDefaultModel'], () => {
    void restore()
  })

  /** Coalesce writes. */
  function schedule() {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, WRITE_DEBOUNCE_MS)
    timer.unref?.()
  }

  /** Persist the remembered selection when it changed. */
  function flush() {
    const selection = remembered
    if (selection === undefined) return
    const key = selectionKey(selection)
    if (key === persistedKey) return
    persistedKey = key
    const record = { version: STATE_VERSION, updatedAt: Date.now(), selection }
    writing = writing
      .then(() => writeState(stateFile, record))
      .catch((error) => {
        persistedKey = undefined
        logger?.warn?.(`[model-memory] could not persist the model selection: ${String(error)}`)
      })
  }

  /** Read the persisted selection once and make it the deployment default. */
  async function restore() {
    if (restoreAttempted) return
    restoreAttempted = true
    remembered = await readState(stateFile, logger)
    if (remembered === undefined) return
    persistedKey = selectionKey(remembered)

    const defaults = ctx.get('agentDefaultModel')
    if (defaults === undefined) return
    const current = safeCurrent(defaults)
    if (current !== undefined && sameSelection(current, remembered)) return

    if (!providerAvailable(ctx.get('llm'), remembered.provider)) {
      logger?.warn?.(`[model-memory] provider "${remembered.provider}" is no longer routable; keeping the current default model`)
      return
    }
    if (typeof defaults.saveSelection !== 'function' || ctx.get('configEditor') === undefined) {
      logger?.warn?.('[model-memory] no configuration editor is mounted, so the remembered model cannot become the startup default')
      return
    }

    try {
      await defaults.saveSelection({ ...remembered })
      logger?.info?.(`[model-memory] restored the startup model ${remembered.provider}/${remembered.model}`)
    } catch (error) {
      logger?.warn?.(`[model-memory] could not restore the remembered model: ${String(error)}`)
    }
  }
}

/**
 * A delegation-owned session must never decide the startup model.
 *
 * Ordinary sessions carry `delegationDepth: 0`, so the test is strictly
 * greater than zero; `parentSession` alone is not enough, because a fork the
 * user opens as a root is still their own choice.
 */
function isAgentOwnedSession(session) {
  const header = session?.header
  if (header === undefined) return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/** Extract one selection from a durable event, or undefined when it carries none. */
function selectionOf(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type === 'model/selection') return normalizeSelection(event.data)
  if (event.type !== 'request/header') return undefined
  return normalizeSelection(event.data?.header?.config)
}

/** Keep only the fields the default-model service accepts. */
function normalizeSelection(value) {
  if (value === null || typeof value !== 'object') return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const selection = { provider, model }
  const effort = value.reasoningEffort
  if (typeof effort === 'string' && effort !== '') selection.reasoningEffort = effort
  return selection
}

/** Compare two normalized selections. */
function sameSelection(left, right) {
  if (left === undefined || right === undefined) return false
  return left.provider === right.provider
    && left.model === right.model
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

/** Stable identity of a selection for change detection. */
function selectionKey(selection) {
  return `${selection.provider}\u0000${selection.model}\u0000${selection.reasoningEffort ?? ''}`
}

/** Read the live default without letting a missing service fail the restore. */
function safeCurrent(defaults) {
  try {
    return normalizeSelection(defaults.currentSelection?.())
  } catch {
    return undefined
  }
}

/** Best-effort check that the remembered provider still has a registered adapter. */
function providerAvailable(llm, provider) {
  if (llm === undefined || typeof llm.listProviders !== 'function') return true
  try {
    return llm.listProviders().some((entry) => entry?.id === provider)
  } catch {
    return true
  }
}

/** Read the persisted record, tolerating an absent or damaged file. */
async function readState(stateFile, logger) {
  let raw
  try {
    raw = await readFile(stateFile, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.(`[model-memory] could not read ${stateFile}: ${String(error)}`)
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    return normalizeSelection(parsed?.selection ?? parsed)
  } catch (error) {
    logger?.warn?.(`[model-memory] ignoring an unreadable state file ${stateFile}: ${String(error)}`)
    return undefined
  }
}

/** Atomically replace the state file. */
async function writeState(stateFile, record) {
  await mkdir(dirname(stateFile), { recursive: true })
  const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await rename(temporary, stateFile)
}
