// =============================================================================
// WORK-001 — One-Active-PR Invariant Check (W001-AC09 / GOV-005 / rule 8)
// =============================================================================
// Verifies the GitHub-state invariant that a Work Item has at most one active
// (open) implementation PR. This complements the specification-consistency
// validator: scripts/spec-validator.ts checks the specification TEXT; this
// check establishes the invariant against live GitHub repository state, so
// the evidence no longer relies on any single PR (Architect Review
// correction AR-002).
//
// Classification: an open PR is an implementation PR for Work Item
// `WORK-xxx` when its title or head-branch name references `WORK-xxx`
// (e.g. title "WORK-001: ..." or branch "work-001-governance-clean").
// Open PRs that reference no Work Item are reported as unattributed and do
// not count against the invariant.
//
// Fail-closed contract (an invariant that cannot be established is a
// FAILURE, never a skip):
//   - exit 0 — invariant holds (deterministic summary on stdout)
//   - exit 1 — invariant violated (two or more open PRs reference one Work
//              Item)
//   - exit 2 — the invariant could NOT be established (missing token, API
//              failure, malformed response, unreadable fixture)
//
// Usage:
//   bun scripts/pr-invariant-check.ts --repo <owner>/<name>
//   GITHUB_TOKEN=... bun scripts/pr-invariant-check.ts --repo <owner>/<name>
//
// Token resolution: the GITHUB_TOKEN environment variable; otherwise the
// credential embedded in the `origin` git remote URL (local convenience).
// In CI, pass secrets.GITHUB_TOKEN via the GITHUB_TOKEN environment
// variable. The token is never printed.
//
// Testing: `--fixture <file.json>` replaces the live GitHub API with a JSON
// file containing an array of pull-request summaries (or {"pulls": [...]}),
// where each entry has `number` (integer), `title` (string), and `head`
// (branch name string, GitHub-style {ref: "..."} object, or null). This lets
// the negative tests prove the check fails on violations and fails closed on
// operational errors. `--api-base <url>` overrides the REST API base URL.
//
// Like the specification validator, this script is dependency-free
// (node:* builtins plus the runtime fetch global only).
// =============================================================================

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

interface PrSummary {
  number: number
  title: string
  head: string | null
}

interface CliArgs {
  repo: string | null
  fixture: string | null
  apiBase: string
}

const API_BASE_DEFAULT = 'https://api.github.com'
const PER_PAGE = 100
const MAX_PAGES = 10

function failClosed(message: string): never {
  process.stderr.write(`PR INVARIANT CHECK ERROR (fail-closed): ${message}\n`)
  process.exit(2)
}

function usage(): string {
  return 'usage: pr-invariant-check.ts [--repo <owner>/<name>] [--fixture <file>] [--api-base <url>]'
}

function parseArgs(argv: string[]): CliArgs {
  let repo: string | null = null
  let fixture: string | null = null
  let apiBase: string | null = null
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--repo' || arg === '--fixture' || arg === '--api-base') {
      if (!next) failClosed(`${usage()} — ${arg} requires a value`)
      if (arg === '--repo') repo = next
      else if (arg === '--fixture') fixture = next
      else apiBase = next
      i += 1
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length)
    } else if (arg.startsWith('--fixture=')) {
      fixture = arg.slice('--fixture='.length)
    } else if (arg.startsWith('--api-base=')) {
      apiBase = arg.slice('--api-base='.length)
    } else {
      failClosed(`${usage()} — unknown argument: ${arg}`)
    }
  }
  return { repo, fixture, apiBase: apiBase ?? API_BASE_DEFAULT }
}

const { repo, fixture, apiBase } = parseArgs(process.argv)

/** Normalize a work-item reference: `work-1` / `WORK-001` -> `WORK-001`. */
function normalizeWorkRef(digits: string): string {
  return `WORK-${String(parseInt(digits, 10)).padStart(3, '0')}`
}

/** Work Item IDs referenced by a PR's title or head-branch name. */
function referencedWorkItems(pr: PrSummary): Set<string> {
  const haystack = `${pr.title}\n${pr.head ?? ''}`
  const refs = new Set<string>()
  const pattern = /\bWORK[-_ ]?(\d+)\b/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(haystack)) !== null) {
    refs.add(normalizeWorkRef(match[1]))
  }
  return refs
}

/** Coerce one API/fixture entry into a PrSummary, failing closed on garbage. */
function toPrSummary(entry: unknown): PrSummary {
  if (typeof entry !== 'object' || entry === null) {
    failClosed('pull request entry is not an object')
  }
  const record = entry as Record<string, unknown>
  if (typeof record.number !== 'number' || !Number.isInteger(record.number)) {
    failClosed('pull request entry has no integer "number" field')
  }
  if (typeof record.title !== 'string') {
    failClosed(`pull request #${String(record.number)} has no string "title" field`)
  }
  let head: string | null = null
  const rawHead = record.head
  if (typeof rawHead === 'string') {
    head = rawHead
  } else if (typeof rawHead === 'object' && rawHead !== null) {
    const ref = (rawHead as Record<string, unknown>).ref
    if (typeof ref === 'string') {
      head = ref
    } else if (ref !== undefined && ref !== null) {
      failClosed(`pull request #${String(record.number)} has a malformed "head" field`)
    }
  } else if (rawHead !== undefined && rawHead !== null) {
    failClosed(`pull request #${String(record.number)} has a malformed "head" field`)
  }
  return { number: record.number, title: record.title, head }
}

/** Load pull requests from a JSON fixture file (negative-test isolation). */
function loadFixturePrs(path: string): PrSummary[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (cause) {
    failClosed(`cannot read fixture ${path}: ${String(cause)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    failClosed(`fixture ${path} is not valid JSON: ${String(cause)}`)
  }
  const entries: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>).pulls)
      ? ((parsed as Record<string, unknown>).pulls as unknown[])
      : failClosed(`fixture ${path} must be a JSON array of pull requests or {"pulls": [...]}`)
  return entries.map(toPrSummary)
}

/** Resolve a GitHub API token: GITHUB_TOKEN env, then the origin remote URL. */
function tokenFromEnvironment(): string | null {
  const envToken = process.env.GITHUB_TOKEN
  if (envToken && envToken.length > 0) return envToken
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' })
  if (remote.status !== 0 || typeof remote.stdout !== 'string') return null
  const match = remote.stdout.trim().match(/^https:\/\/[^:/@]+:([^@]+)@/)
  return match ? match[1] : null
}

/** Fetch all open pull requests from the GitHub REST API (fail-closed). */
async function fetchOpenPrs(ownerSlashRepo: string, base: string, token: string): Promise<PrSummary[]> {
  const prs: PrSummary[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${base}/repos/${ownerSlashRepo}/pulls?state=open&per_page=${PER_PAGE}&page=${page}`
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'iaas-governance-pr-invariant-check',
        },
      })
    } catch (cause) {
      failClosed(`GitHub API request failed (${url}): ${String(cause)}`)
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      failClosed(
        `GitHub API returned HTTP ${response.status} for ${url}${body ? ` — ${body.slice(0, 300)}` : ''}`,
      )
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      failClosed(`GitHub API returned malformed JSON for ${url}: ${String(cause)}`)
    }
    if (!Array.isArray(payload)) {
      failClosed(`GitHub API returned a non-array payload for ${url}`)
    }
    for (const entry of payload) prs.push(toPrSummary(entry))
    if (payload.length < PER_PAGE) return prs
  }
  failClosed(
    `repository ${ownerSlashRepo} exposes more than ${MAX_PAGES * PER_PAGE} open pull requests; ` +
      'the one-active-PR invariant cannot be established (fail-closed)',
  )
}

/** Group open PRs by referenced Work Item and detect AC09 violations. */
function evaluateInvariant(prs: PrSummary[]): {
  attributed: Map<string, number[]>
  unattributed: number[]
  violations: string[]
} {
  const attributed = new Map<string, number[]>()
  const unattributed: number[] = []
  for (const pr of prs) {
    const refs = referencedWorkItems(pr)
    if (refs.size === 0) {
      unattributed.push(pr.number)
      continue
    }
    for (const id of refs) {
      const list = attributed.get(id) ?? []
      list.push(pr.number)
      attributed.set(id, list)
    }
  }
  const violations: string[] = []
  for (const [id, numbers] of [...attributed.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (numbers.length > 1) {
      numbers.sort((a, b) => a - b)
      violations.push(
        `Work Item ${id} has ${numbers.length} active implementation PRs (#${numbers.join(', #')}); ` +
          'at most one is allowed (W001-AC09 / GOV-005 / frozen rule 8)',
      )
    }
  }
  return { attributed, unattributed, violations }
}

async function main(): Promise<void> {
  let prs: PrSummary[]
  if (fixture) {
    prs = loadFixturePrs(fixture)
  } else {
    if (!repo) {
      failClosed(`${usage()} — --repo is required for live GitHub-state verification`)
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      failClosed(`--repo must be <owner>/<name>, received: ${repo}`)
    }
    const token = tokenFromEnvironment()
    if (!token) {
      failClosed(
        'no GitHub token available (set GITHUB_TOKEN; the invariant check must not run unauthenticated)',
      )
    }
    prs = await fetchOpenPrs(repo, apiBase, token)
  }

  const { attributed, unattributed, violations } = evaluateInvariant(prs)

  if (violations.length > 0) {
    process.stdout.write('PR INVARIANT FAILED\n')
    for (const violation of violations) process.stdout.write(`${violation}\n`)
    process.stdout.write(`one-active-PR invariant violated with ${violations.length} violation(s)\n`)
    process.exit(1)
  }

  process.stdout.write('PR INVARIANT PASSED\n')
  process.stdout.write(
    `open-prs=${prs.length} work-items-with-active-prs=${attributed.size} ` +
      `unattributed-open-prs=${unattributed.length}\n`,
  )
  for (const [id, numbers] of [...attributed.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    numbers.sort((a, b) => a - b)
    process.stdout.write(`${id}: active-prs=${numbers.length} (pr=#${numbers.join(', #')})\n`)
  }
  process.exit(0)
}

main().catch((cause: unknown) => {
  failClosed(`unexpected failure: ${String(cause)}`)
})
