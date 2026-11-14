// Synthetic conversations for the evals: each is written by hand around
// planted facts, padded with generated tool output, and comes with probes,
// questions whose answers a good summary must still give. Nothing here comes
// from a real session.

import type { Message } from '../hooks/transcript.ts'
import { csvRows, hex, logLines, NOUNS, pad, pick, prose, pyCode, rng, tsCode, type Theme } from './filler.ts'

export type Probe = {
  id: string
  /** What kind of thing is asked for: scores are broken down by it. */
  kind: 'goal' | 'instruction' | 'decision' | 'rejected' | 'superseded' | 'state' | 'identifier' | 'value' | 'error' | 'never-stated'
  q: string
  /** The answer is right when it matches every one of these; a never-stated probe has none, and is right when the answer is UNKNOWN. */
  accept: RegExp[]
  /** ...and none of these. */
  reject?: RegExp[]
  /** A literal the source message holds: where a citation should point. */
  src?: string
}

export type Fixture = { name: string; split: 'dev' | 'held-out'; about: string; messages: Message[]; probes: Probe[] }

/** One hand-written conversation, before padding: `topic` names it in the questions of a session that holds several. */
type Story = Fixture & { topic: string }

// A small builder.

class Talk {
  messages: Message[] = []
  private n = 0
  user(text: string): this {
    this.messages.push({ role: 'user', text })
    return this
  }
  say(text: string): this {
    this.messages.push({ role: 'assistant', text, toolUses: [] })
    return this
  }
  /** The assistant calls a tool (with a line of narration or none) and reads its result. */
  tool(tool: string, input: Record<string, unknown>, output: string, narration = '', isError = false): this {
    this.n++
    this.messages.push({ role: 'assistant', text: narration, toolUses: [{ tool, input }] })
    this.messages.push({ role: 'user', text: '', toolResults: [isError ? { text: output, isError: true } : { text: output }] })
    return this
  }
  bash(command: string, output: string, narration = '', isError = false): this {
    return this.tool('Bash', { command }, output, narration, isError)
  }
  read(path: string, content: string, narration = ''): this {
    return this.tool('Read', { file_path: path }, content, narration)
  }
  edit(path: string, oldText: string, newText: string, narration = ''): this {
    return this.tool('Edit', { file_path: path, old_string: oldText, new_string: newText }, `The file ${path} has been updated.`, narration)
  }
  write(path: string, content: string, narration = ''): this {
    return this.tool('Write', { file_path: path, content }, `File created successfully at: ${path}`, narration)
  }
}

// What pads each conversation to the size of a real session.

const THEMES: Record<string, Theme> = {
  'flaky-test': {
    kind: 'py',
    targetChars: 200_000,
    files: ['payments/core/refunds.py', 'payments/core/ledger_export.py', 'payments/db/pool.py', 'payments/api/handlers.py', 'payments/core/reconcile.py', 'payments/tests/conftest.py', 'payments/tests/test_ledger.py', 'payments/core/fees.py', 'payments/workers/settle_worker.py', 'payments/db/tx.py'],
    commands: ['grep -rn "idempotency" payments/ --include=*.py | head -30', 'pytest payments/tests/test_ledger.py -q 2>&1 | tail -20', 'git log --oneline -15 -- payments/core', 'grep -rn "tx()" payments/core | head -30', 'ls -la payments/migrations | tail -20'],
    nearMisses: [
      'REFUND_RETRY_BACKOFF_MS = 200',
      'LOCK_TIMEOUT_MS = 350',
      'POOL_ACQUIRE_TIMEOUT_MS = 500',
      '# payments/migrations/0039_batch_status_index.sql added the batch status index',
      '# see PAY-2219 for the partial settlement bug',
      'def test_settle_batch_partial(db, batch_factory):',
      'CREATE INDEX ledger_entries_batch_id_idx ON ledger_entries (batch_id);',
      '# CI for the api package: pytest -n 2 --dist loadscope payments/api',
      '# hotfixes for the last release went to release/2026.10',
      '    assert db.count("ledger_entries", batch_id=batch.id) == 3',
    ],
    notes: ['Checking whether the refund path shares the same pattern.', 'Looking for other callers of find_by_idempotency_key.', 'Seeing how the fixtures set up the database.', 'Checking the worker that calls settle_batch.'],
  },
  'rate-limiter': {
    kind: 'ts',
    targetChars: 200_000,
    files: ['gateway/src/middleware/auth.ts', 'gateway/src/middleware/cors.ts', 'gateway/src/middleware/logging.ts', 'gateway/src/routes/keys.ts', 'gateway/src/routes/usage.ts', 'gateway/src/routes/health.ts', 'gateway/src/app.ts', 'gateway/src/metrics.ts', 'gateway/src/errors.ts', 'gateway/test/helpers.ts'],
    commands: ['grep -rn "redis\\." gateway/src | head -30', 'grep -rn "addHook" gateway/src', 'cd gateway && npx vitest run src/middleware 2>&1 | tail -20', 'git log --oneline -15 -- gateway/src', 'grep -rn "plan" gateway/src/routes | head -30'],
    nearMisses: [
      'const SESSION_TTL_MS = 600000',
      'const AUTH_TIMEOUT_MS = 50',
      'export const SEATS: Record<Plan, number> = { free: 3, team: 60, enterprise: 600 }',
      'export const CORS_MAX_AGE = 300',
      "  return reply.code(401).send({ error: { code: 'unauthorized', message } })",
      '  REQUEST_LOG_ENABLED: z.coerce.boolean().default(true),',
      '// login throttling uses a sliding window, see auth.ts',
      '  await redis.pexpire(`sess:${id}`, 1800000)',
      "  metrics.increment('auth.fail_closed')",
      '// the session-store rollout went us-east, then eu-west, then ap-south',
    ],
    notes: ['Checking how other middleware reads the plan of a key.', 'Looking at the error helpers for the envelope.', 'Seeing how metrics are emitted elsewhere.', 'Checking the order hooks are registered in.'],
  },
  'sales-analysis': {
    kind: 'data',
    targetChars: 70_000,
    files: ['data/accounts.csv', 'data/regions.csv', 'analysis/helpers.py', 'analysis/old_report.py', 'notebooks/scratch.py'],
    commands: [
      'python3 -c "import pandas as pd; df=pd.read_csv(\'data/orders_2025.csv\'); print(df.groupby([\'region\',\'month\']).units.sum().head(40))"',
      'python3 -c "import pandas as pd; df=pd.read_csv(\'data/orders_2025.csv\'); print(df[df.duplicated(\'order_id\')].head(30))"',
      'python3 -c "import pandas as pd; df=pd.read_csv(\'data/orders_2025.csv\'); print(df.sample(30, random_state=1))"',
      'head -40 data/accounts.csv',
    ],
    nearMisses: [
      'north    Q2->Q3   +1.8%   (calendar quarters: +2.4%)',
      'west: top3 share of loss 0.118',
      'acc_7be1d   -1240.0',
      'central  monthly Q3  5,876k',
      'accounts down: 455 of 1790   (north)',
      'fiscal_start_month = 4  # the old report assumed April',
      'south    +2.0%   Q3->Q4 by calendar quarters',
      'acc_test9,south,internal,2025-03',
    ],
    notes: ['Checking units as a sanity check on the revenue numbers.', 'Looking at the same split for the other regions, for comparison.', 'Checking for duplicated order ids.', 'Seeing how the old report grouped the months.'],
  },
  'migration': {
    kind: 'config',
    targetChars: 250_000,
    files: ['services/billing/src/main.py', 'services/catalog/README.md', 'services/exports/tests/test_config.py', 'services/gateway/Dockerfile', 'services/identity/src/sso.py', 'services/inventory/src/main.py', 'services/notifications/src/main.py', 'services/reporting/tests/test_config.py', 'services/shared/README.md', 'services/gateway/src/main.py'],
    commands: ['grep -rn "config.yaml" services/ --include=*.py --include=Dockerfile --include=*.md | head -30', 'git status --short | head -40', 'grep -rn "yaml" services/*/requirements.txt', 'ls services/*/tests 2>/dev/null | head -40', 'grep -rn "safe_load" services/ | head -30'],
    nearMisses: [
      '  timeout_ms: 2026',
      'cutoff_default = "2025-12-31"',
      '  issuer_default: null',
      'class Loader(BaseLoader):  # local to this service, not vendored',
      'analyzers: &legacy_analyzer',
      "KeyError: 'issuer'  # old traceback kept in the README",
      'OPTIONAL_FIELDS = ("issuer_default",)',
      '# Docker base images are owned by platform, ask in #platform-infra',
      '# services/reporting had no tests until 2025',
    ],
    notes: ['Checking that nothing else in the service reads config.yaml directly.', 'Looking for hard-coded references to the YAML path.', 'Checking the Dockerfile copies the new file.', 'Seeing whether PyYAML is still needed by this service.'],
  },
  'docs-rewrite': {
    kind: 'docs',
    targetChars: 70_000,
    files: ['docs/reference/cli.md', 'docs/reference/config.md', 'docs/api/overview.md', 'docs/start/_sidebar.md', 'docs/CONTRIBUTING.md', 'docs/guides/deploying.md', 'docs/guides/teams.md'],
    commands: ['grep -rn "project" docs/start | head -30', 'grep -rn -i "simply\\|just\\|easy" docs/start | head -30', 'grep -rn "```" docs/reference | head -30', 'git log --oneline -10 -- docs/start'],
    nearMisses: [
      'Requires macOS 12 or later (legacy installer).',
      'Headings in the API reference use Title Case.',
      'The reference keeps American spelling for identifiers such as `color`.',
      'You see a version number such as `tool 4.1.3`.',
      'Keep reference pages under 800 words.',
      'The sync engine checks for changes every 30 seconds.',
      'A project (the old name for a workspace) holds your code.',
      '## Connecting A Repo',
    ],
    notes: ['Checking how other pages label their code blocks.', 'Looking at the sidebar to see how the pages link to each other.', 'Checking the reference for the exact command names.', 'Seeing where else the old noun is used.'],
  },
  'incident': {
    kind: 'ops',
    targetChars: 70_000,
    files: ['deploy/consumer/Chart.yaml', 'deploy/consumer/templates/configmap.yaml', 'deploy/consumer/templates/hpa.yaml', 'deploy/producer/values.yaml', 'deploy/consumer/README.md', 'runbooks/kestrel-lag.md'],
    commands: ['kubectl -n ingest get hpa', 'kubectl -n ingest logs deploy/kestrel-consumer --tail=30', 'kubectl -n ingest top pods -l app=kestrel-consumer', 'kubectl -n ingest get events --sort-by=.lastTimestamp | tail -30', 'helm -n ingest history kestrel-consumer | tail -10'],
    nearMisses: [
      'KESTREL_FETCH_MAX_BYTES=500',
      '  max.poll.interval.ms: "300000"',
      'producer:\n  maxBatchRecords: 50',
      'REVISION: 56  superseded',
      'TOTAL LAG: 12,480   (topic ingest.audit.v1)',
      'Legacy runbook: page the SRE secondary if lag passes 5 million.',
      'The September outage was handled in #inc-4390.',
      'consumer 8.13.1 changed session.timeout.ms',
    ],
    notes: ['Checking the autoscaler is not interfering.', 'Looking at the producer side for comparison.', 'Checking the runbook for the documented procedure.', 'Reading the recent events in the namespace.'],
  },
}

// 1. A flaky test, debugged over several turns.

function flakyTest(): Story {
  const t = new Talk()
  t.user(
    'The test `test_settle_batch_idempotent` in payments/tests/test_settlement.py fails about one run in five on CI but never on my machine. Find out why and fix it. ' +
      'Two rules for this repo: do not touch anything under payments/legacy/, and never mock the database in tests here, we always run against the real Postgres container.',
  )
  t.read('payments/tests/test_settlement.py', `import pytest\nfrom payments.core.settlement import settle_batch\n\n${pyCode(11, 9)}\n\ndef test_settle_batch_idempotent(db, batch_factory):\n    batch = batch_factory(entries=3)\n    settle_batch(batch.id, idempotency_key="k-1")\n    settle_batch(batch.id, idempotency_key="k-1")\n    assert db.count("ledger_entries", batch_id=batch.id) == 1, "expected 1 ledger row, found %d"\n`, "I'll start with the test itself.")
  t.bash('for i in $(seq 1 20); do pytest payments/tests/test_settlement.py::test_settle_batch_idempotent -q -x 2>&1 | tail -1; done', Array.from({ length: 20 }, () => '1 passed in 0.41s').join('\n'), 'Running it 20 times locally to see whether it ever fails here.')
  t.say('Twenty passes out of twenty locally, as you said. CI must run it differently, so I will look at the CI configuration next.')
  t.read('.ci/pipeline.yml', `stages:\n  - lint\n  - test\n\ntest:\n  image: python:3.12\n  services:\n    - postgres:16\n  script:\n    - pip install -r requirements-dev.txt\n    - pytest -n 4 --dist loadfile payments/\n\n${logLines(12, 14, 'ci-runner')}`)
  t.bash('pytest -n 4 payments/tests/test_settlement.py -q 2>&1 | tail -15', `${logLines(13, 8, 'pytest-xdist')}\nFAILED payments/tests/test_settlement.py::test_settle_batch_idempotent - AssertionError: expected 1 ledger row, found 2\n1 failed, 11 passed in 3.87s`, 'CI runs with `pytest -n 4` (xdist), locally you run serially. Reproducing with four workers.')
  t.read('payments/core/settlement.py', `from payments.db import tx\nfrom payments.core.ledger import find_by_idempotency_key, insert_entry\n\nRETRY_BACKOFF_MS = 200\n\n${pyCode(14, 7)}\n\ndef settle_batch(batch_id, idempotency_key):\n    existing = find_by_idempotency_key(idempotency_key)\n    if existing is not None:\n        return existing\n    with tx() as conn:\n        entry = insert_entry(conn, batch_id, idempotency_key)\n    return entry\n\n${pyCode(15, 6)}`, 'It fails under four workers. Reading the code under test.')
  t.say(
    'Found it. `settle_batch` in payments/core/settlement.py checks `find_by_idempotency_key` outside the transaction that inserts the row, so two concurrent calls with the same key can both see "no existing entry" and both insert. ' +
      'It is a check-then-insert race, and it only shows when tests run in parallel. Two ways to fix it:\n\n' +
      '(a) guard `settle_batch` with a `threading.Lock`;\n(b) add a unique constraint on `ledger_entries(idempotency_key)` and insert with `ON CONFLICT DO NOTHING`, then read the row back.\n\nWhich do you prefer?',
  )
  t.user('Not (a): we run several worker processes in production, so an in-process lock would not protect anything. Go with (b). The migration must be number 0042, call it 0042_ledger_idempotency_unique.sql. And build the index with CREATE UNIQUE INDEX CONCURRENTLY, the table has about 80 million rows and we cannot lock it.')
  t.bash('ls payments/migrations | tail -5', '0038_refund_reason.sql\n0039_batch_status_index.sql\n0040_tenant_currency.sql\n0041_ledger_partition_key.sql\nREADME.md', 'Checking the latest migration number.')
  t.write('payments/migrations/0042_ledger_idempotency_unique.sql', '-- no transaction: CONCURRENTLY cannot run inside one\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ledger_entries_idempotency_key_uq\n    ON ledger_entries (idempotency_key);\n')
  t.edit('payments/core/settlement.py', '    existing = find_by_idempotency_key(idempotency_key)\n    if existing is not None:\n        return existing\n    with tx() as conn:\n        entry = insert_entry(conn, batch_id, idempotency_key)\n    return entry', '    with tx() as conn:\n        entry = insert_entry(conn, batch_id, idempotency_key, on_conflict="nothing")\n        if entry is None:\n            entry = find_by_idempotency_key(idempotency_key, conn=conn)\n    return entry', 'Now the insert itself decides: on a conflict nothing is written and the existing row is read back in the same transaction.')
  t.read('payments/core/ledger.py', `${pyCode(16, 10)}\n\ndef insert_entry(conn, batch_id, idempotency_key, on_conflict=None):\n    sql = INSERT_SQL + (" ON CONFLICT (idempotency_key) DO NOTHING" if on_conflict == "nothing" else "")\n    return conn.fetch_one(sql + " RETURNING *", batch_id, idempotency_key)\n\n${pyCode(17, 5)}`, '`insert_entry` already takes `on_conflict`; confirming how it builds the statement.')
  t.bash('for i in $(seq 1 50); do pytest -n 4 payments/tests/test_settlement.py -q 2>&1 | tail -1; done | sort | uniq -c', '     50 12 passed in 3.9s', 'Fifty parallel runs to check the fix.')
  t.say('Fifty runs with four workers, zero failures. I will run the whole payments suite once to make sure nothing else moved.')
  t.bash('pytest -n 4 payments/ -q 2>&1 | tail -12', `${logLines(18, 7, 'pytest-xdist')}\nFAILED payments/tests/test_refunds.py::test_refund_rounding - AssertionError: Decimal('10.005') != Decimal('10.01')\n1 failed, 318 passed, 4 skipped in 61.20s`)
  t.say('One failure in the full suite: `test_refund_rounding` in payments/tests/test_refunds.py, a rounding assertion. It does not touch settlement. Do you want me to look into it?')
  t.user('No, leave it. That one is known and tracked in PAY-2291. While you are in settlement.py, raise the retry backoff in settle_batch from 200ms to 350ms.')
  t.edit('payments/core/settlement.py', 'RETRY_BACKOFF_MS = 200', 'RETRY_BACKOFF_MS = 350')
  t.bash('grep -rn "RETRY_BACKOFF_MS" payments/ --include=*.py', 'payments/core/settlement.py:4:RETRY_BACKOFF_MS = 350\npayments/core/settlement.py:41:        time.sleep(RETRY_BACKOFF_MS / 1000)\npayments/tests/test_settlement.py:88:    assert settlement.RETRY_BACKOFF_MS >= 200', 'Checking who else reads the constant.')
  t.say('Backoff is now 350ms; the only test that reads it asserts `>= 200`, so it still holds.')
  t.user('Actually make it 500ms, I just checked the dashboard and 350 is still too tight for the settlement provider.')
  t.edit('payments/core/settlement.py', 'RETRY_BACKOFF_MS = 350', 'RETRY_BACKOFF_MS = 500')
  t.bash('git status --short && git diff --stat', ' M payments/core/settlement.py\n?? payments/migrations/0042_ledger_idempotency_unique.sql\n payments/core/settlement.py | 11 ++++++-----\n 1 file changed, 6 insertions(+), 5 deletions(-)')
  t.user('Good. Two more things before you open the PR: add an entry to CHANGELOG.md under "Unreleased", and target the branch release/2026.11, not main. Commit messages here are imperative mood with no ticket prefix.')
  t.read('CHANGELOG.md', `# Changelog\n\n## Unreleased\n\n- Add tenant currency to settlement exports.\n\n## 2026.10\n\n${prose(19, 16, 'release notes')}`, 'Reading the changelog to match its style before I add the entry.')
  return {
    name: 'flaky-test',
    topic: 'the flaky settlement test in the payments repository',
    messages: t.messages,
    split: 'dev',
    about: 'A flaky test debugged over several turns: a race, a rejected fix, a migration, a value changed twice.',
    probes: [
      { id: 'test', kind: 'identifier', q: 'What is the name of the flaky test I was asked to fix?', accept: [/test_settle_batch_idempotent/], src: 'test_settle_batch_idempotent' },
      { id: 'cause', kind: 'decision', q: 'What was the root cause of the flaky test?', accept: [/race|concurren|parallel|both insert|outside (of )?the transaction|check-then-insert/i], src: 'check-then-insert race' },
      { id: 'assertion', kind: 'error', q: 'What exactly did the failing assertion say (the numbers of ledger rows expected and found)?', accept: [/expected 1/i, /found 2|2 (ledger )?rows/i], src: 'expected 1 ledger row, found 2' },
      { id: 'legacy', kind: 'instruction', q: 'Which directory did the user say must not be touched?', accept: [/payments\/legacy/], src: 'payments/legacy/' },
      { id: 'mock', kind: 'instruction', q: "What is the user's rule about the database in tests?", accept: [/mock/i, /real|postgres|never|not|no /i], src: 'never mock the database' },
      { id: 'rejected', kind: 'rejected', q: 'Which fix did the user reject, and why?', accept: [/lock/i, /process|worker/i], src: 'in-process lock would not protect' },
      { id: 'migration', kind: 'identifier', q: 'What is the file name of the migration that was written?', accept: [/0042_ledger_idempotency_unique\.sql/], src: '0042_ledger_idempotency_unique.sql' },
      { id: 'concurrently', kind: 'instruction', q: 'How did the user want the index built, and what was the reason?', accept: [/concurrently/i, /80 ?(million|M)|lock/i], src: 'CREATE UNIQUE INDEX CONCURRENTLY, the table' },
      { id: 'backoff', kind: 'superseded', q: 'What is the retry backoff in settle_batch set to now?', accept: [/\b500 ?ms\b|\b500\b/], src: 'Actually make it 500ms' },
      { id: 'unrelated', kind: 'state', q: 'Which unrelated test fails in the full suite, and under which ticket is it tracked?', accept: [/test_refund_rounding/, /PAY-2291/], src: 'PAY-2291' },
      { id: 'todo', kind: 'state', q: 'What is left to do before the work is finished?', accept: [/changelog/i, /\bPR\b|pull request/i], src: 'add an entry to CHANGELOG.md' },
      { id: 'branch', kind: 'instruction', q: 'Which branch must the pull request target?', accept: [/release\/2026\.11/], src: 'release/2026.11' },
      { id: 'ci-flag', kind: 'value', q: 'How does CI run pytest differently from the user (which flag)?', accept: [/-n 4|four workers|4 workers|xdist/i], src: 'pytest -n 4 --dist loadfile' },
      { id: 'commit-style', kind: 'instruction', q: 'What is the convention for commit messages in this repo?', accept: [/imperative/i], src: 'imperative mood with no ticket prefix' },
      { id: 'index-name', kind: 'identifier', q: 'What is the name of the unique index the migration creates?', accept: [/ledger_entries_idempotency_key_uq/], src: 'ledger_entries_idempotency_key_uq' },
      { id: 'verified', kind: 'value', q: 'How was the fix verified: how many parallel runs, and how many failed?', accept: [/\b50\b|fifty/i, /\b(0|zero|no|none|without)\b/i], src: 'Fifty runs with four workers, zero failures' },
      { id: 'suite', kind: 'value', q: 'How many tests passed in the full payments suite run?', accept: [/\b318\b/], src: '318 passed' },
      { id: 'backoff-test', kind: 'value', q: 'One test reads RETRY_BACKOFF_MS. What does it assert about the value?', accept: [/>= ?200|at least 200|200 or more|greater than or equal to 200/i], src: 'RETRY_BACKOFF_MS >= 200' },
      { id: 'reviewer', kind: 'never-stated', q: 'Which reviewer did the user ask me to assign the pull request to?', accept: [] },
      { id: 'deadline', kind: 'never-stated', q: 'What deadline did the user give for this fix?', accept: [] },
      { id: 'pr-number', kind: 'never-stated', q: 'What is the number of the pull request that was opened?', accept: [] },
    ],
  }
}

// 2. A feature designed and built: a rate limiter.

function rateLimiter(): Story {
  const t = new Talk()
  t.user(
    'I need rate limiting on our public API gateway (TypeScript, the code is in gateway/src). Per API key, with limits that differ by plan. ' +
      'Constraints: we already run Redis 7 for sessions so use that, no new infrastructure; and whatever you build has to fail open, if Redis is down requests go through. Show me a design before writing code.',
  )
  t.bash('ls gateway/src gateway/src/middleware && cat gateway/package.json | head -30', `gateway/src:\napp.ts\nconfig.ts\nmiddleware\nplans.ts\nredis.ts\nroutes\n\ngateway/src/middleware:\nauth.ts\ncors.ts\nlogging.ts\n\n{\n  "name": "gateway",\n  "dependencies": {\n    "fastify": "^5.1.0",\n    "ioredis": "^5.4.1",\n    "zod": "^3.23.8"\n  }\n}`, 'Looking at what is there first.')
  t.read('gateway/src/plans.ts', `export type Plan = 'free' | 'team' | 'enterprise'\n\n${tsCode(21, 8)}\n\nexport const PLAN_OF_KEY_PREFIX: Record<string, Plan> = { fk_: 'free', tk_: 'team', ek_: 'enterprise' }`)
  t.read('gateway/src/redis.ts', `import Redis from 'ioredis'\n\nexport const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2, enableOfflineQueue: false })\n\n${tsCode(22, 7)}`)
  t.say(
    'Design proposal:\n\n1. Algorithm: a sliding-window counter per API key, kept in Redis as two fixed windows weighted by overlap. It is cheap (two INCRs) and smooths the burst at window edges that a plain fixed window allows.\n' +
      '2. Alternative: a token bucket in a Lua script. It allows controlled bursts but needs a script and a hash per key.\n3. Limits per plan in gateway/src/plans.ts: free 60 requests a minute, team 600, enterprise 6000.\n' +
      '4. A Fastify `onRequest` hook in gateway/src/middleware/rateLimit.ts, after auth, that answers 429 with a Retry-After header.\n5. Fail open: any Redis error or a timeout over 50ms lets the request through and counts a metric.\n\nI lean to the sliding window. Thoughts?',
  )
  t.user(
    'Token bucket, not sliding window. Our enterprise customers send bursts when their nightly jobs start and I want to allow a burst of twice the per-minute rate as long as the average holds; a sliding window cannot express that. ' +
      'Limits: free 60/min is fine, team should be 300/min not 600, enterprise 6000/min. Also the 429 body must be our standard error envelope: {"error":{"code":"rate_limited","message":...,"retry_after_ms":...}}.',
  )
  t.write('gateway/src/middleware/tokenBucket.lua', '-- KEYS[1] bucket hash; ARGV: rate_per_ms, capacity, now_ms, cost\nlocal b = redis.call("HMGET", KEYS[1], "tokens", "ts")\nlocal tokens = tonumber(b[1]) or tonumber(ARGV[2])\nlocal ts = tonumber(b[2]) or tonumber(ARGV[3])\ntokens = math.min(tonumber(ARGV[2]), tokens + (tonumber(ARGV[3]) - ts) * tonumber(ARGV[1]))\nlocal allowed = tokens >= tonumber(ARGV[4])\nif allowed then tokens = tokens - tonumber(ARGV[4]) end\nredis.call("HSET", KEYS[1], "tokens", tokens, "ts", ARGV[3])\nredis.call("PEXPIRE", KEYS[1], 120000)\nreturn { allowed and 1 or 0, tokens }\n', 'Token bucket it is. The bucket lives in a Redis hash and one Lua script refills and takes atomically.')
  t.write('gateway/src/middleware/rateLimit.ts', `import { redis } from '../redis'\nimport { limitsFor } from '../plans'\n\n${tsCode(23, 5)}\n\nexport async function rateLimit(req, reply) {\n  const { perMinute } = limitsFor(req.apiKey)\n  const capacity = perMinute * 2 // burst: twice the per-minute rate\n  try {\n    const [allowed, tokens] = await withTimeout(redis.evalsha(SHA, 1, \`rl:\${req.apiKey}\`, perMinute / 60000, capacity, Date.now(), 1), 50)\n    if (!allowed) return reply.code(429).header('Retry-After', retryAfter(tokens, perMinute)).send(envelope(tokens, perMinute))\n  } catch (err) {\n    metrics.increment('rate_limit.fail_open')\n  }\n}`)
  t.edit('gateway/src/plans.ts', "export const PLAN_OF_KEY_PREFIX", "export const LIMITS: Record<Plan, { perMinute: number }> = { free: { perMinute: 60 }, team: { perMinute: 300 }, enterprise: { perMinute: 6000 } }\n\nexport const PLAN_OF_KEY_PREFIX")
  t.bash('cd gateway && npx vitest run src/middleware/rateLimit.test.ts 2>&1 | tail -20', `${logLines(24, 6, 'vitest')}\n FAIL  src/middleware/rateLimit.test.ts > rateLimit > refills over time\nAssertionError: expected 0 to be 1\n ❯ src/middleware/rateLimit.test.ts:48:23\n\n Test Files  1 failed (1)\n      Tests  1 failed | 6 passed (7)`, 'I wrote tests alongside; running them.', true)
  t.read('gateway/src/middleware/rateLimit.test.ts', `import { describe, it, expect, vi } from 'vitest'\n\n${tsCode(25, 6)}\n\nit('refills over time', async () => {\n  vi.useFakeTimers()\n  await drain(key)\n  vi.advanceTimersByTime(1000)\n  expect((await take(key)).allowed).toBe(1)\n})`)
  t.say('The failing test is mine, not the limiter: the Lua script gets `Date.now()` from the caller, and under `vi.useFakeTimers()` my helper captured the time before the timers advanced. I will pass the clock in so the test and the middleware share it.')
  t.edit('gateway/src/middleware/rateLimit.ts', 'Date.now(), 1), 50)', 'now(), 1), 50)', 'Injecting `now` so tests can control it.')
  t.bash('cd gateway && npx vitest run src/middleware/rateLimit.test.ts 2>&1 | tail -6', ' ✓ src/middleware/rateLimit.test.ts (7)\n\n Test Files  1 passed (1)\n      Tests  7 passed (7)\n   Duration  1.12s')
  t.user('Nice. One change: the fail-open timeout of 50ms is too generous, our p99 to Redis is 4ms. Make it 15ms. And I want the limiter off by default behind an env flag so we can roll it out per region: RATE_LIMIT_ENABLED.')
  t.edit('gateway/src/middleware/rateLimit.ts', 'now(), 1), 50)', 'now(), 1), 15)')
  t.read('gateway/src/config.ts', `import { z } from 'zod'\n\nconst Env = z.object({\n  REDIS_URL: z.string().url(),\n  PORT: z.coerce.number().default(8080),\n  LOG_LEVEL: z.enum(['debug', 'info', 'warn']).default('info'),\n})\n\n${tsCode(26, 6)}`)
  t.edit('gateway/src/config.ts', "  LOG_LEVEL: z.enum(['debug', 'info', 'warn']).default('info'),", "  LOG_LEVEL: z.enum(['debug', 'info', 'warn']).default('info'),\n  RATE_LIMIT_ENABLED: z.coerce.boolean().default(false),")
  t.edit('gateway/src/app.ts', "app.addHook('onRequest', auth)", "app.addHook('onRequest', auth)\nif (config.RATE_LIMIT_ENABLED) app.addHook('onRequest', rateLimit)")
  t.bash('cd gateway && npx tsc --noEmit && npx vitest run 2>&1 | tail -5', ' Test Files  14 passed (14)\n      Tests  96 passed (96)\n   Duration  6.48s')
  t.say('Type-check and all 96 gateway tests pass. The limiter is behind `RATE_LIMIT_ENABLED` (default off) and fails open after 15ms.')
  t.user('Before I review: the rollout order will be ap-south first, then eu-west, then us-east last since it carries most traffic. Write that into docs/rollout/rate-limiting.md with a rollback step (unset the flag and redeploy). Also we still need a dashboard panel for the rate_limit.fail_open metric, but that is a follow-up, do not do it now.')
  t.bash('ls docs/rollout 2>/dev/null; ls docs | head', `adr\napi\nrollout\nrunbooks\n\ndocs/rollout:\nsession-store.md\ntemplate.md`)
  t.read('docs/rollout/template.md', `# Rollout: <feature>\n\n## Order\n\n## Verification\n\n## Rollback\n\n${prose(27, 12, 'rollouts')}`, 'There is a template; I will follow it.')
  return {
    name: 'rate-limiter',
    topic: 'the rate limiter for the API gateway',
    messages: t.messages,
    split: 'held-out',
    about: 'A feature designed and built: a proposal overruled by the user, limits corrected, a timeout changed, a rollout plan pending.',
    probes: [
      { id: 'algorithm', kind: 'decision', q: 'Which rate limiting algorithm was chosen in the end?', accept: [/token bucket/i], src: 'Token bucket, not sliding window' },
      { id: 'why', kind: 'decision', q: 'Why was that algorithm chosen over the alternative?', accept: [/burst/i], src: 'bursts when their nightly jobs start' },
      { id: 'rejected', kind: 'rejected', q: 'Which algorithm did I propose first that the user turned down?', accept: [/sliding/i], src: 'I lean to the sliding window' },
      { id: 'team-limit', kind: 'superseded', q: 'What is the per-minute limit for the team plan?', accept: [/\b300\b/], src: 'team should be 300/min not 600' },
      { id: 'burst', kind: 'value', q: 'How large a burst does the limiter allow relative to the per-minute rate?', accept: [/twice|2x|2 ?×|double|two times/i], src: 'burst of twice the per-minute rate' },
      { id: 'fail-open', kind: 'instruction', q: 'What must happen to requests when Redis is down?', accept: [/fail open|go through|let .*through|allowed|pass/i], src: 'has to fail open' },
      { id: 'timeout', kind: 'superseded', q: 'After how many milliseconds does the limiter give up on Redis and let the request through?', accept: [/\b15 ?ms\b|\b15\b/], src: 'Make it 15ms' },
      { id: 'flag', kind: 'identifier', q: 'Which environment variable turns the limiter on, and what is its default?', accept: [/RATE_LIMIT_ENABLED/, /off|false|disabled/i], src: 'RATE_LIMIT_ENABLED' },
      { id: 'envelope', kind: 'instruction', q: 'What error code must the 429 response body carry?', accept: [/rate_limited/], src: '"code":"rate_limited"' },
      { id: 'test-bug', kind: 'error', q: 'One test failed at first. What was wrong?', accept: [/clock|Date\.now|fake ?timers?|\btime\b|timestamp/i], src: 'captured the time before the timers advanced' },
      { id: 'rollout', kind: 'instruction', q: 'In which order are the regions rolled out?', accept: [/ap-south[\s\S]*eu-west[\s\S]*us-east/i], src: 'ap-south first, then eu-west, then us-east' },
      { id: 'todo', kind: 'state', q: 'What was I in the middle of doing?', accept: [/rollout|rate-limiting\.md/i], src: 'docs/rollout/rate-limiting.md' },
      { id: 'follow-up', kind: 'state', q: 'What was explicitly left as a follow-up, not to be done now?', accept: [/dashboard|panel/i], src: 'dashboard panel for the rate_limit.fail_open metric' },
      { id: 'infra', kind: 'instruction', q: 'Which piece of infrastructure that the team already runs did the user say the limiter must use?', accept: [/redis/i], src: 'we already run Redis 7' },
      { id: 'key', kind: 'identifier', q: 'Under which Redis key prefix does the limiter keep the bucket of an API key?', accept: [/\brl:/], src: 'rl:' },
      { id: 'expiry', kind: 'value', q: 'The Lua script sets an expiry on the bucket key (PEXPIRE). How long is it?', accept: [/120[ ,]?000|\b120 ?(s|sec)|\b2 ?min|two minutes/i], src: 'PEXPIRE' },
      { id: 'tests-total', kind: 'value', q: 'How many gateway tests passed in the last full run?', accept: [/\b96\b/], src: '96 passed' },
      { id: 'metric', kind: 'identifier', q: 'Which metric is counted when the limiter fails open?', accept: [/rate_limit\.fail_open/], src: 'rate_limit.fail_open' },
      { id: 'file', kind: 'identifier', q: 'In which file does the limiter middleware live, and in which the Lua script?', accept: [/rateLimit\.ts/, /tokenBucket\.lua/], src: 'gateway/src/middleware/tokenBucket.lua' },
      { id: 'startup-plan', kind: 'never-stated', q: 'What per-minute limit applies to the startup plan?', accept: [] },
      { id: 'redis-host', kind: 'never-stated', q: 'What is the hostname of the Redis cluster used in production?', accept: [] },
      { id: 'launch-date', kind: 'never-stated', q: 'On which date does the rollout start?', accept: [] },
    ],
  }
}

// 3. A data analysis with corrections from the user.

function salesAnalysis(): Story {
  const t = new Talk()
  t.user('I have last year\'s orders in data/orders_2025.csv. I want to know which region grew the most quarter over quarter, and whether the Q4 dip everyone talks about is real. Use pandas. Amounts are in EUR, keep them in EUR.')
  t.bash('head -25 data/orders_2025.csv && wc -l data/orders_2025.csv', `${csvRows(31, 24)}\n  184213 data/orders_2025.csv`, 'Looking at the file first.')
  t.bash("python3 -c \"import pandas as pd; df=pd.read_csv('data/orders_2025.csv'); print(df.describe(include='all').T)\"", `           count unique      top   freq        mean         std     min      25%      50%      75%       max\norder_id  184212    NaN      NaN    NaN  55012.4  25980.11   10000  32511.0  55020.0  77498.0   99998\naccount   184212   9120 acc_test1  6044       NaN       NaN     NaN      NaN      NaN      NaN       NaN\nregion    184212      5    north  41877       NaN       NaN     NaN      NaN      NaN      NaN       NaN\nmonth     184212     12  2025-11  17650       NaN       NaN     NaN      NaN      NaN      NaN       NaN\nnet_eur   184212    NaN      NaN    NaN  1998.72   1155.30    0.00   997.41  1999.05  2998.76   3999.99\nunits     184212    NaN      NaN    NaN    20.48     11.54       1       10       20       30        40`)
  t.say('184,212 orders, 9,120 accounts, five regions. One thing stands out: the most frequent account is `acc_test1` with 6,044 orders. That looks like a test account. Should it be in the analysis?')
  t.user('Good catch, no. Drop every account whose id starts with acc_test, there are a few of them. Also our fiscal year starts in February, so Q1 is Feb to Apr, Q2 May to Jul, Q3 Aug to Oct, Q4 Nov to Jan. January 2025 belongs to the previous fiscal year, leave it out.')
  t.write('analysis/quarters.py', "import pandas as pd\n\ndf = pd.read_csv('data/orders_2025.csv')\ndf = df[~df.account.str.startswith('acc_test')]\ndf['m'] = df.month.str[-2:].astype(int)\ndf = df[df.m != 1]  # January 2025 is in the previous fiscal year\ndf['fq'] = ((df.m - 2) // 3 + 1).clip(upper=4)\nby = df.groupby(['region', 'fq']).net_eur.sum().unstack()\nprint(by.round(0))\nprint((by.pct_change(axis=1) * 100).round(1))\n")
  t.bash('python3 analysis/quarters.py', `fq            1          2          3          4\nregion\ncentral  16210344.0  17004918.0  17630221.0  11802377.0\neast     15988120.0  16102554.0  18877340.0  12240981.0\nnorth    19004871.0  19650112.0  20011745.0  13420660.0\nsouth    14120009.0  16944010.0  17201899.0  11630412.0\nwest     15540772.0  15601338.0  15712004.0  10498821.0\nfq         1     2     3     4\nregion\ncentral  NaN   4.9   3.7 -33.1\neast     NaN   0.7  17.2 -35.2\nnorth    NaN   3.4   1.8 -32.9\nsouth    NaN  20.0   1.5 -32.4\nwest     NaN   0.4   0.7 -33.2\n${logLines(32, 5, 'pandas')}`, 'Running with the test accounts removed and fiscal quarters.')
  t.say('With test accounts out (that removed 7,311 orders across 4 test accounts) and fiscal quarters: the largest single quarter-over-quarter growth is south, +20.0% from Q1 to Q2; east follows with +17.2% from Q2 to Q3. Every region drops about a third in Q4, but that Q4 only has two months of data here (November and December; January 2026 is not in the file), so the dip is mostly an artefact of a short quarter.')
  t.user('Right, that is what I suspected. To compare fairly, normalise to revenue per month within each quarter. And when you report numbers to me, round to thousands of EUR and write them like 1,234k, I do not want long digit strings.')
  t.edit('analysis/quarters.py', "by = df.groupby(['region', 'fq']).net_eur.sum().unstack()", "months = df.groupby('fq').m.nunique()\nby = df.groupby(['region', 'fq']).net_eur.sum().unstack() / months")
  t.bash('python3 analysis/quarters.py', `fq           1         2         3         4\nregion\ncentral  5403448.0  5668306.0  5876740.0  5901188.0\neast     5329373.0  5367518.0  6292447.0  6120490.0\nnorth    6334957.0  6550037.0  6670582.0  6710330.0\nsouth    4706670.0  5648003.0  5733966.0  5815206.0\nwest     5180257.0  5200446.0  5237335.0  5249410.0\nfq         1     2     3    4\nregion\ncentral  NaN   4.9   3.7  0.4\neast     NaN   0.7  17.2 -2.7\nnorth    NaN   3.4   1.8  0.6\nsouth    NaN  20.0   1.5  1.4\nwest     NaN   0.4   0.7  0.2\n${logLines(33, 5, 'pandas')}`)
  t.say('Per month, the Q4 dip disappears: four regions are flat to slightly up in Q4 (central +0.4%, north +0.6%, south +1.4%, west +0.2%). Only east really falls, by 2.7%, from 6,292k to 6,120k a month. So the "Q4 dip" is real only in east.')
  t.user('Interesting. Dig into east: is it a few big accounts leaving or broad?')
  t.write('analysis/east.py', "import pandas as pd\n\ndf = pd.read_csv('data/orders_2025.csv')\ndf = df[~df.account.str.startswith('acc_test') & (df.region == 'east')]\ndf['m'] = df.month.str[-2:].astype(int)\nq3 = df[df.m.isin([8, 9, 10])].groupby('account').net_eur.sum() / 3\nq4 = df[df.m.isin([11, 12])].groupby('account').net_eur.sum() / 2\nd = (q4.reindex(q3.index).fillna(0) - q3).sort_values()\nprint(d.head(8).round(0)); print('accounts down:', (d < 0).sum(), 'of', len(d)); print('top3 share of loss:', (d.head(3).sum() / d[d < 0].sum()).round(3))\n")
  t.bash('python3 analysis/east.py', `account\nacc_7be1c   -61240.0\nacc_02f9a   -48911.0\nacc_d41e7   -37005.0\nacc_91c3b    -4120.0\nacc_5a0e2    -3987.0\nacc_c77d0    -3610.0\nacc_18f4e    -3402.0\nacc_e3b96    -3377.0\ndtype: float64\naccounts down: 902 of 1811\ntop3 share of loss: 0.412\n${logLines(34, 6, 'pandas')}`)
  t.say('It is concentrated. Three accounts, acc_7be1c, acc_02f9a and acc_d41e7, make up 41.2% of east\'s monthly loss between Q3 and Q4 (-61k, -49k and -37k a month). Beyond them the picture is ordinary churn: 902 of 1,811 accounts are down, about half, each by small amounts.')
  t.user('Those three I know, they moved to annual invoicing in November so their orders no longer show monthly. That explains it. Please write this up as a short memo in reports/q4-dip.md: one paragraph of conclusion first, then the table per region, then the east drill-down. No charts, the people reading it use a text-only mail client.')
  t.bash('ls reports 2>/dev/null || echo "no reports dir"; python3 -c "import pandas; print(pandas.__version__)"', 'no reports dir\n2.2.3')
  t.read('analysis/quarters.py', "import pandas as pd\n\ndf = pd.read_csv('data/orders_2025.csv')\ndf = df[~df.account.str.startswith('acc_test')]\ndf['m'] = df.month.str[-2:].astype(int)\ndf = df[df.m != 1]  # January 2025 is in the previous fiscal year\ndf['fq'] = ((df.m - 2) // 3 + 1).clip(upper=4)\nmonths = df.groupby('fq').m.nunique()\nby = df.groupby(['region', 'fq']).net_eur.sum().unstack() / months\nprint(by.round(0))\nprint((by.pct_change(axis=1) * 100).round(1))\n", 'Re-reading the script so the memo states the method exactly.')
  return {
    name: 'sales-analysis',
    topic: 'the analysis of the 2025 orders',
    messages: t.messages,
    split: 'held-out',
    about: 'A data analysis: numbers, corrections to the method, an explanation found, a memo to write.',
    probes: [
      { id: 'goal', kind: 'goal', q: 'What two questions did the user want answered from the orders data?', accept: [/region/i, /Q4|dip/i], src: 'which region grew the most quarter over quarter' },
      { id: 'test-accounts', kind: 'instruction', q: 'Which accounts are excluded from the analysis?', accept: [/acc_test|test account/i], src: 'starts with acc_test' },
      { id: 'fiscal', kind: 'instruction', q: 'In which month does the fiscal year start?', accept: [/feb/i], src: 'fiscal year starts in February' },
      { id: 'january', kind: 'instruction', q: 'What is done with January 2025 in the analysis, and why?', accept: [/left out|exclud|drop|omit|remov|not included/i], src: 'January 2025 belongs to the previous fiscal year' },
      { id: 'top-growth', kind: 'value', q: 'Which region had the largest quarter-over-quarter growth, how much, and between which quarters?', accept: [/south/i, /20(\.0)? ?%/], src: 'south, +20.0% from Q1 to Q2' },
      { id: 'dip', kind: 'decision', q: 'Is the Q4 dip real? What did the analysis conclude?', accept: [/east/i, /artefact|artifact|short|two months|only|not real|disappear/i], src: 'the Q4 dip disappears' },
      { id: 'east-drop', kind: 'value', q: 'By what percentage did east fall per month in Q4?', accept: [/2\.7/], src: 'by 2.7%' },
      { id: 'normalise', kind: 'decision', q: 'How were quarters made comparable given that Q4 is short?', accept: [/per month|monthly|month/i], src: 'normalise to revenue per month' },
      { id: 'format', kind: 'instruction', q: 'How does the user want numbers reported?', accept: [/thousands?|\d ?k\b/i], src: 'write them like 1,234k' },
      { id: 'three-accounts', kind: 'identifier', q: 'Which three accounts explain most of the fall in east?', accept: [/acc_7be1c/, /acc_02f9a/, /acc_d41e7/], src: 'acc_7be1c, acc_02f9a and acc_d41e7' },
      { id: 'share', kind: 'value', q: "What share of east's loss do those three accounts make up?", accept: [/41(\.2)? ?%|0\.412/], src: '41.2%' },
      { id: 'explanation', kind: 'decision', q: 'Why did those three accounts drop?', accept: [/annual/i], src: 'moved to annual invoicing in November' },
      { id: 'memo', kind: 'state', q: 'What deliverable remains to be written, and where?', accept: [/reports\/q4-dip\.md/], src: 'reports/q4-dip.md' },
      { id: 'no-charts', kind: 'instruction', q: 'Should the memo include charts? Why?', accept: [/\bno\b|\bnot\b|without/i, /text[- ]only|plain[- ]text|mail client/i], src: 'text-only mail client' },
      { id: 'rows', kind: 'value', q: 'How many orders does the file hold?', accept: [/184[,. ]?21[23]/], src: '184,212 orders' },
      { id: 'removed', kind: 'value', q: 'How many orders were removed as test accounts, and across how many test accounts?', accept: [/7[,. ]?311/, /\b(4|four)\b/i], src: 'removed 7,311 orders across 4 test accounts' },
      { id: 'second', kind: 'value', q: 'Which region had the second largest quarter-over-quarter growth, and how much?', accept: [/east/i, /17\.2/], src: 'east follows with +17.2%' },
      { id: 'east-monthly', kind: 'value', q: "What was east's revenue per month in Q3 and in Q4?", accept: [/6[,. ]?292/, /6[,. ]?120/], src: 'from 6,292k to 6,120k a month' },
      { id: 'accounts-down', kind: 'value', q: 'How many east accounts were down between Q3 and Q4, out of how many?', accept: [/\b902\b/, /1[,. ]?811/], src: '902 of 1,811 accounts' },
      { id: 'recipient', kind: 'never-stated', q: 'Who is the memo addressed to, by name?', accept: [] },
      { id: 'memo-deadline', kind: 'never-stated', q: 'By when does the user need the memo?', accept: [] },
      { id: 'revenue-2024', kind: 'never-stated', q: 'What was the total revenue in 2024?', accept: [] },
    ],
  }
}

// 4. One prompt, then a long autonomous run of tool calls.

function migration(): Story {
  const t = new Talk()
  t.user(
    'Migrate every service under services/ from config.yaml to config.toml. For each service: convert the file, update the loader in src/config.py to read TOML with tomllib, run that service\'s tests, and delete the old YAML only once tests pass. ' +
      'Keep going until all of them are done, do not stop to ask me between services. If a service has no tests, convert it but keep the YAML and list it at the end. Do not change any value while converting, and keep the comments.',
  )
  t.bash('ls services', 'billing\ncatalog\nexports\ngateway\nidentity\ninventory\nnotifications\npricing\nreporting\nsearch\nshipping\nwebhooks', 'Twelve services. I will go through them alphabetically.')
  const services: { name: string; outcome: 'ok' | 'fixed' | 'notests' | 'blocked'; note?: string; seed: number }[] = [
    { name: 'billing', outcome: 'ok', seed: 41 },
    { name: 'catalog', outcome: 'ok', seed: 42 },
    { name: 'exports', outcome: 'fixed', note: 'dates', seed: 43 },
    { name: 'gateway', outcome: 'ok', seed: 44 },
    { name: 'identity', outcome: 'fixed', note: 'nulls', seed: 45 },
    { name: 'inventory', outcome: 'notests', seed: 46 },
    { name: 'notifications', outcome: 'ok', seed: 47 },
    { name: 'pricing', outcome: 'blocked', seed: 48 },
    { name: 'reporting', outcome: 'ok', seed: 49 },
  ]
  for (const s of services) {
    const r = rng(s.seed)
    const yaml = `# ${s.name} service configuration\nservice:\n  name: ${s.name}\n  port: ${8000 + Math.floor(r() * 900)}\n  workers: ${2 + Math.floor(r() * 6)}\n# upstreams\nupstream:\n  timeout_ms: ${500 + Math.floor(r() * 4000)}\n  retries: ${1 + Math.floor(r() * 4)}\n${Array.from({ length: 14 }, () => `  ${pick(r, NOUNS)}_${pick(r, NOUNS)}: ${Math.floor(r() * 9000)}`).join('\n')}\n`
    t.read(`services/${s.name}/config.yaml`, yaml, s.name === 'billing' ? 'Starting with billing.' : '')
    if (s.outcome === 'blocked') {
      t.read(`services/${s.name}/src/config.py`, `import yaml\nfrom vendor_cfg import SharedLoader  # pinned, see services/pricing/VENDORED.md\n\n${pyCode(s.seed + 100, 5)}\n\nclass Loader(SharedLoader):\n    FORMAT = "yaml"\n`)
      t.read(`services/${s.name}/VENDORED.md`, `# Vendored configuration loader\n\nThe loader in src/config.py subclasses vendor_cfg.SharedLoader, which is owned by the platform team and only reads YAML. Do not replace it; changes go through platform (#platform-config). ${prose(s.seed, 6, 'vendoring')}`)
      t.say('pricing is different: its loader subclasses `vendor_cfg.SharedLoader`, which only reads YAML and, per services/pricing/VENDORED.md, is owned by the platform team and must not be replaced. I cannot migrate pricing without changing vendored code, so I am skipping it and will report it at the end.')
      continue
    }
    t.write(`services/${s.name}/config.toml`, yaml.replace(/^(\w+):$/gm, '[$1]').replace(/^  (\w+): /gm, '$1 = ').replace(/name = (\w+)/, 'name = "$1"'))
    t.edit(`services/${s.name}/src/config.py`, 'import yaml\n\ndef load(path="config.yaml"):\n    with open(path) as f:\n        return yaml.safe_load(f)', 'import tomllib\n\ndef load(path="config.toml"):\n    with open(path, "rb") as f:\n        return tomllib.load(f)')
    if (s.outcome === 'notests') {
      t.bash(`ls services/${s.name}/tests 2>/dev/null | head; cd services/${s.name} && pytest -q 2>&1 | tail -3`, 'no tests ran in 0.01s', '', true)
      t.say(`${s.name} has no tests at all. As instructed I converted it and updated the loader, but I am keeping services/${s.name}/config.yaml and will list it at the end.`)
      continue
    }
    if (s.outcome === 'fixed' && s.note === 'dates') {
      t.bash(`cd services/${s.name} && pytest -q 2>&1 | tail -14`, `${logLines(s.seed, 5, 'pytest')}\nFAILED tests/test_schedule.py::test_cutoff_is_string - AssertionError: assert datetime.date(2026, 1, 31) == '2026-01-31'\n1 failed, 22 passed in 2.10s`, '', true)
      t.say('exports fails one test: in YAML `cutoff: "2026-01-31"` was a quoted string, and I wrote it unquoted in TOML, where a bare 2026-01-31 is a date. That changed the value\'s type, which I must not do. Quoting it.')
      t.edit(`services/${s.name}/config.toml`, 'cutoff = 2026-01-31', 'cutoff = "2026-01-31"')
    }
    if (s.outcome === 'fixed' && s.note === 'nulls') {
      t.bash(`cd services/${s.name} && pytest -q 2>&1 | tail -14`, `${logLines(s.seed, 5, 'pytest')}\nFAILED tests/test_sso.py::test_optional_issuer - KeyError: 'issuer_override'\n1 failed, 40 passed in 3.31s`, '', true)
      t.say('identity fails `test_optional_issuer` with KeyError: \'issuer_override\'. The YAML had `issuer_override: null`, and TOML has no null, so I had dropped the key. The code indexes it directly. The least invasive fix that changes no value is in the loader: after loading, set the keys listed in OPTIONAL_KEYS to None when absent.')
      t.edit(`services/${s.name}/src/config.py`, '        return tomllib.load(f)', '        cfg = tomllib.load(f)\n    for key in OPTIONAL_KEYS:\n        cfg.setdefault(key, None)\n    return cfg')
    }
    t.bash(`cd services/${s.name} && pytest -q 2>&1 | tail -3`, `${20 + Math.floor(r() * 60)} passed in ${(1 + r() * 4).toFixed(2)}s`)
    t.bash(`git rm -q services/${s.name}/config.yaml && git status --short services/${s.name}`, ` D services/${s.name}/config.yaml\n M services/${s.name}/src/config.py\n?? services/${s.name}/config.toml`)
  }
  t.read('services/search/config.yaml', `# search service configuration\nservice:\n  name: search\n  port: 8442\n  workers: 6\n# index settings: anchors are used to share the analyzer block\nanalyzers: &default_analyzer\n  tokenizer: icu\n  filters: [lowercase, asciifolding]\nindexes:\n  products:\n    analyzer: *default_analyzer\n  articles:\n    analyzer: *default_analyzer\n${logLines(50, 4, 'yaml')}`, 'Nine done or decided. Next is search.')
  t.say('search uses a YAML anchor (`&default_analyzer`) that two indexes share. TOML has no anchors, so I will write the analyzer block out under each index: the values stay identical, only the sharing goes away. I will note that in a comment in the TOML.')
  return {
    name: 'migration',
    topic: 'the migration of the services from YAML to TOML config',
    messages: t.messages,
    split: 'dev',
    about: 'One prompt and a long autonomous run: twelve services, per-service outcomes, two fixes, one blocked, one without tests, three left.',
    probes: [
      { id: 'goal', kind: 'goal', q: 'What is the task I was given?', accept: [/toml/i, /yaml/i], src: 'from config.yaml to config.toml' },
      { id: 'no-ask', kind: 'instruction', q: 'What did the user say about stopping or asking between services?', accept: [/not stop|n[o']t (to )?(stop|ask|pause|check)|without (stopping|asking|pausing|checking)|keep going|no (stopping|asking|check-ins?|interruptions?)|never (stop|ask)/i], src: 'do not stop to ask me between services' },
      { id: 'values', kind: 'instruction', q: 'What must not change during conversion, and what must be kept?', accept: [/value/i, /comment/i], src: 'Do not change any value while converting, and keep the comments' },
      { id: 'delete-rule', kind: 'instruction', q: 'When may the old YAML file of a service be deleted?', accept: [/tests? pass/i], src: 'delete the old YAML only once tests pass' },
      { id: 'blocked', kind: 'state', q: 'Which service was skipped entirely, and why?', accept: [/pricing/i, /vendor|platform|SharedLoader/i], src: 'I cannot migrate pricing' },
      { id: 'notests', kind: 'state', q: 'Which service has no tests, and what was done about its YAML file?', accept: [/inventory/i, /kept|keep|keeping|not deleted|left/i], src: 'inventory has no tests at all' },
      { id: 'exports-bug', kind: 'error', q: 'What went wrong when migrating the exports service, and how was it fixed?', accept: [/date|cutoff/i, /quot|string/i], src: 'cutoff: "2026-01-31"' },
      { id: 'identity-bug', kind: 'error', q: 'What went wrong when migrating the identity service?', accept: [/null|none|issuer_override/i], src: 'issuer_override: null' },
      { id: 'identity-fix', kind: 'decision', q: 'How was the identity problem fixed?', accept: [/OPTIONAL_KEYS|setdefault|loader|None/i], src: 'set the keys listed in OPTIONAL_KEYS to None' },
      { id: 'current', kind: 'state', q: 'Which service was I working on when the conversation was cut off?', accept: [/\bsearch\b/i], reject: [/\b(reporting|shipping|webhooks)\b was/i], src: 'Next is search' },
      { id: 'anchor', kind: 'decision', q: 'What is special about the search service config, and how will it be handled?', accept: [/anchor/i, /each|inline|writ|duplicat|expand|repeat/i], src: 'YAML anchor' },
      { id: 'remaining', kind: 'state', q: 'Which services have not been started yet (after the one in progress)?', accept: [/shipping/i, /webhooks/i], src: 'reporting\nsearch\nshipping\nwebhooks' },
      { id: 'done-list', kind: 'state', q: 'Which services were fully migrated with their YAML deleted? Answer with the service names only, separated by commas.', accept: [/billing/i, /catalog/i, /exports/i, /gateway/i, /identity/i, /notifications/i, /reporting/i], reject: [/pricing|inventory|search|shipping|webhooks/i] },
      { id: 'final-report', kind: 'instruction', q: 'What has to be listed for the user at the end?', accept: [/inventory|no tests|without tests|pricing|skipped/i], src: 'list it at the end' },
      { id: 'loader', kind: 'decision', q: 'Which module does the new loader use to read the config?', accept: [/tomllib/], src: 'import tomllib' },
      { id: 'vendored', kind: 'identifier', q: "Which file says the pricing loader must not be replaced, and through which channel do changes to it go?", accept: [/VENDORED\.md/, /#?platform-config/], src: '#platform-config' },
      { id: 'exports-test', kind: 'identifier', q: 'Which test failed in the exports service?', accept: [/test_cutoff_is_string/], src: 'test_cutoff_is_string' },
      { id: 'identity-test', kind: 'identifier', q: 'Which test failed in the identity service?', accept: [/test_optional_issuer/], src: 'test_optional_issuer' },
      { id: 'total', kind: 'value', q: 'How many services are there under services/ in total?', accept: [/\b12\b|twelve/i], src: 'Twelve services' },
      { id: 'ticket', kind: 'never-stated', q: 'Under which ticket is this migration tracked?', accept: [] },
      { id: 'toml-writer', kind: 'never-stated', q: 'Which library did the user ask me to use for writing TOML?', accept: [] },
      { id: 'owner', kind: 'never-stated', q: 'Who owns the shipping service?', accept: [] },
    ],
  }
}

// 5. Long instructions from the user, whose wording matters.

function docsRewrite(): Story {
  const t = new Talk()
  t.user(
    'I want you to rewrite our getting-started docs in docs/start/. Read this carefully because the style rules are not negotiable:\n\n' +
      '1. The product noun is "workspace". Never "project", never "repo", even where the old docs say so.\n2. British spelling throughout: organise, colour, behaviour.\n3. Headings in sentence case, never title case.\n' +
      '4. Never use the words "simply", "just" or "easy". If something is easy the reader will notice.\n5. Every code block must say which shell it is for; we have many Windows users, so give PowerShell alongside bash whenever commands differ.\n' +
      '6. Second person, present tense. "You create a workspace", not "the user will create".\n\n' +
      `${prose(51, 10, 'documentation style')}\n\nThe audience is people who have never used a terminal-based tool before. Start with docs/start/install.md.`,
  )
  t.bash('ls docs/start && wc -w docs/start/*.md', 'concepts.md\nfirst-workspace.md\ninstall.md\ntroubleshooting.md\n   412 docs/start/concepts.md\n   655 docs/start/first-workspace.md\n   380 docs/start/install.md\n   298 docs/start/troubleshooting.md\n  1745 total')
  t.read('docs/start/install.md', `# Installing The CLI\n\nInstalling is easy! Simply run the installer for your platform.\n\n\`\`\`\ncurl -fsSL https://get.example.dev/install.sh | sh\n\`\`\`\n\nThe user will then need to create a project. ${prose(52, 14, 'installation')}\n\n## Verifying Your Install\n\nJust run \`tool --version\`. ${prose(53, 8, 'verification')}`)
  t.write('docs/start/install.md', '# Installing the CLI\n\nYou install the CLI with one command. Pick the tab for your shell.\n\n```bash\ncurl -fsSL https://get.example.dev/install.sh | sh\n```\n\n```powershell\nirm https://get.example.dev/install.ps1 | iex\n```\n\n## Checking the installation\n\nRun `tool --version`. You see a version number such as `tool 4.2.0`.\n\n## Next: create your first workspace\n\nContinue with [Your first workspace](first-workspace.md).\n', 'Rewriting install.md under the six rules.')
  t.say('install.md is rewritten: sentence-case headings, second person, "workspace", no "simply/just/easy", and a PowerShell block beside the bash one. One question: the old page linked to a "System requirements" section that does not exist anywhere. Should I write one, or drop the link?')
  t.user('Drop the link for now, but add a one-line note at the top of install.md saying it needs macOS 13 or later, Windows 11, or a Linux with glibc 2.31 or later. I will get the full requirements from the platform team later. Carry on with first-workspace.md.')
  t.edit('docs/start/install.md', '# Installing the CLI\n', '# Installing the CLI\n\n> Requires macOS 13 or later, Windows 11, or Linux with glibc 2.31 or later.\n')
  t.read('docs/start/first-workspace.md', `# Creating Your First Project\n\n${prose(54, 18, 'first steps')}\n\n\`\`\`\ntool init my-project\ncd my-project\ntool dev\n\`\`\`\n\n## Project Layout\n\n${prose(55, 16, 'layout')}\n\n## Connecting A Repo\n\nSimply run \`tool link\` and the project is connected to your repo. ${prose(56, 9, 'linking')}`)
  t.write('docs/start/first-workspace.md', '# Your first workspace\n\nA workspace is a folder that holds your code and its settings. You create one with `tool init`.\n\n```bash\ntool init my-workspace\ncd my-workspace\ntool dev\n```\n\nThe commands are the same in PowerShell.\n\n## What is in a workspace\n\nYou find three things in a new workspace: `tool.toml` (settings), `src/` (your code) and `.tool/` (generated files; you never edit these).\n\n## Connecting a Git remote\n\nRun `tool link` inside the workspace. It asks for the address of the remote and stores it in `tool.toml`.\n')
  t.user('Two corrections. First, "Git remote" is right as a term but the heading should be "Connecting your code host", that is how the UI labels it. Second, you wrote "The commands are the same in PowerShell" as prose: rule 5 says every code block names its shell, so when the commands are identical label the block "bash / PowerShell" instead of adding a sentence. Apply that to install.md as well wherever it fits. And from now on, show me a diff summary after each file rather than the whole file, I only need to see what changed.')
  t.edit('docs/start/first-workspace.md', '## Connecting a Git remote', '## Connecting your code host')
  t.edit('docs/start/first-workspace.md', '```bash\ntool init my-workspace\ncd my-workspace\ntool dev\n```\n\nThe commands are the same in PowerShell.\n', '```bash / PowerShell\ntool init my-workspace\ncd my-workspace\ntool dev\n```\n')
  t.bash('git diff --stat docs/start', ' docs/start/first-workspace.md | 61 +++++++-----------\n docs/start/install.md         | 44 +++++--------\n 2 files changed, 38 insertions(+), 67 deletions(-)')
  t.say('Diff summary: first-workspace.md, heading renamed to "Connecting your code host" and the shell sentence replaced by a "bash / PowerShell" label on the block. install.md has no identical-command blocks (bash and PowerShell differ there), so nothing to change. Next is concepts.md.')
  t.read('docs/start/concepts.md', `# Core Concepts\n\n## Projects And Environments\n\n${prose(57, 20, 'concepts')}\n\n## The Sync Engine\n\n${prose(58, 22, 'sync')}\n\n## Colors And Themes\n\n${prose(59, 8, 'themes')}`)
  t.user('For concepts.md: cut "Colours and themes" completely, it does not belong in getting started; I will move it to the customisation guide myself. Keep the page under 300 words. And the sync engine section must mention that sync is one-way, from the workspace to the cloud, never back: support gets that question every week.')
  t.write('docs/start/concepts.md', '# Core concepts\n\n## Workspaces and environments\n\nA workspace holds your code. An environment is a running copy of a workspace: you have one for development and one for production.\n\n## The sync engine\n\nThe sync engine copies changes from your workspace to the cloud. Sync is one-way: from the workspace to the cloud, never back. If you change something in the cloud console, you do not see it in your workspace.\n')
  t.bash('wc -w docs/start/concepts.md && git diff --stat docs/start/concepts.md', '      71 docs/start/concepts.md\n docs/start/concepts.md | 58 ++++---------\n 1 file changed, 9 insertions(+), 49 deletions(-)')
  t.say('Diff summary for concepts.md: 49 lines removed, 9 added; it is now 71 words, "Colours and themes" is gone, and the sync section states that sync is one-way, from the workspace to the cloud. The last page is troubleshooting.md.')
  t.read('docs/start/troubleshooting.md', `# Troubleshooting\n\n## The Install Script Fails\n\n${prose(60, 12, 'install errors')}\n\n## "Project Not Found"\n\n${prose(61, 10, 'lookup errors')}\n\n## Sync Is Stuck\n\nJust delete the .tool folder. ${prose(62, 9, 'sync errors')}`)
  return {
    name: 'docs-rewrite',
    topic: 'the rewrite of the getting-started docs',
    messages: t.messages,
    split: 'held-out',
    about: 'Long, exact instructions from the user, corrected and extended along the way.',
    probes: [
      { id: 'noun', kind: 'instruction', q: 'Which product noun must be used, and which words must never be used for it?', accept: [/workspace/i, /project/i], src: 'The product noun is "workspace"' },
      { id: 'spelling', kind: 'instruction', q: 'Which spelling convention do the docs follow?', accept: [/british|UK/i], src: 'British spelling throughout' },
      { id: 'banned', kind: 'instruction', q: 'Which three words are banned from the docs?', accept: [/simply/i, /just/i, /easy/i], src: '"simply", "just" or "easy"' },
      { id: 'headings', kind: 'instruction', q: 'What case are headings written in?', accept: [/sentence case/i], src: 'Headings in sentence case' },
      { id: 'shell-label', kind: 'superseded', q: 'When the bash and PowerShell commands are identical, how should the code block be presented?', accept: [/bash \/ PowerShell|label/i], src: 'label the block "bash / PowerShell"' },
      { id: 'voice', kind: 'instruction', q: 'In which person and tense are the docs written?', accept: [/second person/i, /present/i], src: 'Second person, present tense' },
      { id: 'requirements', kind: 'value', q: 'What system requirements does the note at the top of install.md state?', accept: [/macOS 13/i, /Windows 11/i, /glibc 2\.31/i], src: 'macOS 13 or later, Windows 11' },
      { id: 'heading-fix', kind: 'superseded', q: 'What is the heading of the section about linking a remote in first-workspace.md now?', accept: [/Connecting your code host/i], src: 'the heading should be "Connecting your code host"' },
      { id: 'diff', kind: 'instruction', q: 'How does the user want to be shown my changes after each file?', accept: [/diff/i], src: 'show me a diff summary after each file' },
      { id: 'themes', kind: 'decision', q: 'What happened to the "Colours and themes" section of concepts.md, and who handles it?', accept: [/cut|remov|drop|gone|delet/i], src: 'cut "Colours and themes" completely' },
      { id: 'sync', kind: 'instruction', q: 'What must the sync engine section say about the direction of sync?', accept: [/one-way|one way/i, /cloud/i], src: 'sync is one-way, from the workspace to the cloud' },
      { id: 'word-limit', kind: 'value', q: 'What is the word limit for concepts.md?', accept: [/300/], src: 'Keep the page under 300 words' },
      { id: 'audience', kind: 'goal', q: 'Who is the audience of these docs?', accept: [/never used|new to|beginner|no experience|first.time/i], src: 'never used a terminal-based tool before' },
      { id: 'next', kind: 'state', q: 'Which page is left to rewrite?', accept: [/troubleshooting/i], src: 'The last page is troubleshooting.md' },
      { id: 'version', kind: 'value', q: 'Which example version number does install.md show after running the version command?', accept: [/4\.2\.0/], src: 'tool 4.2.0' },
      { id: 'powershell', kind: 'identifier', q: 'What is the PowerShell install command in install.md?', accept: [/install\.ps1/, /iex/], src: 'irm https://get.example.dev/install.ps1 | iex' },
      { id: 'concepts-words', kind: 'value', q: 'How many words long is concepts.md after the rewrite?', accept: [/\b71\b/], src: '71 docs/start/concepts.md' },
      { id: 'contents', kind: 'value', q: 'Which three things does first-workspace.md say a new workspace holds?', accept: [/tool\.toml/, /src/, /\.tool/], src: '`tool.toml` (settings), `src/` (your code) and `.tool/`' },
      { id: 'requirements-link', kind: 'decision', q: 'What was decided about the link to the missing System requirements section?', accept: [/drop|remov|delet|cut|left out/i], src: 'Drop the link for now' },
      { id: 'languages', kind: 'never-stated', q: 'Into which languages will the docs be translated?', accept: [] },
      { id: 'publish-date', kind: 'never-stated', q: 'On which date are the new docs published?', accept: [] },
      { id: 'guide-file', kind: 'never-stated', q: 'What is the file name of the customisation guide?', accept: [] },
    ],
  }
}

// 6. An incident, in a conversation that opens with an earlier summary.

function incident(): Story {
  const t = new Talk()
  t.user(
    'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n' +
      '1. Goal\nThe user is the on-call engineer for the Kestrel ingest pipeline and asked me to help investigate why consumer lag on the topic `ingest.events.v3` keeps growing since the 14:05 UTC deploy, and to get it back to normal without losing events [m0].\n\n' +
      '2. Context\n- The cluster is `kestrel-prod-eu2`; I work through `kubectl` in namespace `ingest` and must not restart brokers: the user said broker restarts need a second approver [m0][m4].\n- The deploy at 14:05 UTC shipped consumer version 8.14.0 (previous: 8.13.2) [m3].\n- Paging policy: if lag passes 2 million events, the user must page the data platform lead [m9].\n\n' +
      '3. Work so far\n- Lag was 310k events at 14:20 and 780k at 14:50 [m6][m12].\n- Consumer pods are healthy and not restarting; CPU is at 35% so it is not saturation [m14].\n- I found that 8.14.0 changed `max.poll.records` from 500 to 50 in deploy/consumer/values.yaml, in a commit titled "tune poll for memory" [m17][m18].\n- The user rejected rolling back the whole release because 8.14.0 also carries a security fix (CVE patch in the TLS library) [m21].\n\n' +
      '4. Decisions\n- We will override `max.poll.records` back to 500 through the Helm value `consumer.maxPollRecords` rather than roll back [m22].\n\n' +
      '5. Current state\nI was about to prepare the Helm override; nothing has been applied yet [m23].\n\n' +
      '6. Working together\n- The user wants every command that changes the cluster shown to them before I run it [m4].\n\n' +
      "## The user's own words in this part of the conversation\n\n- [m0] Lag on ingest.events.v3 keeps growing since the 14:05 deploy. Help me find out why and get it back down, without losing events. Do not restart brokers, that needs a second approver.\n- [m21] No full rollback: 8.14.0 has the TLS CVE fix and security will have my head.\n\n" +
      'If you need specific details from before compaction (exact wording, a value, code, command output) that this summary does not give, read them back with mcp__async-compaction__recall.\n\nThe messages after this summary are the most recent messages from before compaction, kept verbatim.',
  )
  t.say('Here is the command I propose to run, for your approval before I touch the cluster:\n\n`helm upgrade kestrel-consumer deploy/consumer -n ingest --reuse-values --set consumer.maxPollRecords=500`\n\nIt changes only that value and triggers a rolling restart of the consumer pods (not the brokers).')
  t.user('Approved, but add --atomic so it rolls back by itself if the pods do not come up, and set the timeout to 5 minutes.')
  t.bash('helm upgrade kestrel-consumer deploy/consumer -n ingest --reuse-values --set consumer.maxPollRecords=500 --atomic --timeout 5m', `Release "kestrel-consumer" has been upgraded. Happy Helming!\nNAME: kestrel-consumer\nLAST DEPLOYED: Thu Oct  8 15:12:44 2026\nNAMESPACE: ingest\nSTATUS: deployed\nREVISION: 57\n${logLines(71, 8, 'helm')}`)
  t.bash('kubectl -n ingest get pods -l app=kestrel-consumer', `NAME                                READY   STATUS    RESTARTS   AGE\n${Array.from({ length: 12 }, (_, i) => `kestrel-consumer-7c9d8b6f5-${hex(rng(72 + i), 5)}   1/1     Running   0          ${40 + i * 7}s`).join('\n')}`, 'Revision 57 is deployed. Checking the pods.')
  t.bash('kubectl -n ingest exec deploy/kestrel-consumer -- kcat-lag --group ingest-main --topic ingest.events.v3', `partition  current-offset  log-end-offset  lag\n${Array.from({ length: 16 }, (_, i) => `${String(i).padStart(9)}  ${90000000 + i * 1311}  ${90060000 + i * 1311}  ${58000 + ((i * 7919) % 9000)}`).join('\n')}\nTOTAL LAG: 1,012,480\n${logLines(73, 5, 'kcat')}`, 'All 12 pods are running. Now the lag.')
  t.say('Lag is 1,012,480 right after the restart, which is expected: it kept growing during the rollout. What matters is the trend from here; I will sample it again in a few minutes.')
  t.bash('sleep 240; kubectl -n ingest exec deploy/kestrel-consumer -- kcat-lag --group ingest-main --topic ingest.events.v3 | tail -1', 'TOTAL LAG: 1,148,902')
  t.say('Lag went up, not down: 1,148,902 four minutes later. The override did not help, or not enough. Checking whether the pods actually picked the value up.')
  t.bash('kubectl -n ingest exec deploy/kestrel-consumer -- env | grep -i poll; kubectl -n ingest get cm kestrel-consumer -o yaml | grep -n -i "poll"', `KESTREL_MAX_POLL_RECORDS=50\n14:  max.poll.records: "500"\n${logLines(74, 4, 'kubectl')}`)
  t.say('There is the problem. The ConfigMap says `max.poll.records: "500"`, but the pods run with the environment variable `KESTREL_MAX_POLL_RECORDS=50`, and in this consumer the environment variable wins over the file. The 8.14.0 chart sets that variable in the Deployment template, so the Helm value I changed never reached the process.')
  t.read('deploy/consumer/templates/deployment.yaml', `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: kestrel-consumer\nspec:\n  replicas: {{ .Values.consumer.replicas }}\n  template:\n    spec:\n      containers:\n        - name: consumer\n          image: "registry.internal/kestrel/consumer:{{ .Values.image.tag }}"\n          env:\n            - name: KESTREL_MAX_POLL_RECORDS\n              value: "50"   # hard-coded in 8.14.0, see commit 3f9a2c1\n            - name: KESTREL_GROUP\n              value: ingest-main\n${logLines(75, 10, 'template')}`)
  t.say('Confirmed in deploy/consumer/templates/deployment.yaml: `KESTREL_MAX_POLL_RECORDS` is hard-coded to "50" (commit 3f9a2c1). Two options:\n\n(a) patch the template so the variable reads `{{ .Values.consumer.maxPollRecords }}`, which needs a chart change and a review;\n(b) right now, `kubectl set env deployment/kestrel-consumer KESTREL_MAX_POLL_RECORDS=500 -n ingest`, which works at once but Helm will overwrite it on the next upgrade.\n\nI suggest (b) now to stop the bleeding and (a) as the durable fix. The command for (b), for your approval:\n\n`kubectl -n ingest set env deployment/kestrel-consumer KESTREL_MAX_POLL_RECORDS=500`')
  t.user('Do (b) now, approved. Lag is at 1.2M and I have to page at 2M, so move. Open the chart fix as a draft PR afterwards and tag me, my handle is @rosalind-ek. Also note for the postmortem: the incident channel is #inc-4417.')
  t.bash('kubectl -n ingest set env deployment/kestrel-consumer KESTREL_MAX_POLL_RECORDS=500 && kubectl -n ingest rollout status deployment/kestrel-consumer --timeout=5m', `deployment.apps/kestrel-consumer env updated\nWaiting for deployment "kestrel-consumer" rollout to finish: 4 of 12 updated replicas are available...\nWaiting for deployment "kestrel-consumer" rollout to finish: 9 of 12 updated replicas are available...\ndeployment "kestrel-consumer" successfully rolled out`)
  t.bash('for i in 1 2 3; do kubectl -n ingest exec deploy/kestrel-consumer -- kcat-lag --group ingest-main --topic ingest.events.v3 | tail -1; sleep 120; done', 'TOTAL LAG: 1,304,117\nTOTAL LAG: 1,071,560\nTOTAL LAG: 822,945')
  t.say('It is draining now: 1,304,117 at the peak, then 1,071,560, then 822,945, about 120k events a minute. At that rate the backlog clears in roughly seven minutes. The peak stayed under the 2 million paging threshold, so no page was needed.')
  t.user('Great. While it drains, prepare the chart PR. Branch name fix/consumer-poll-records-env. Keep the default at 500 in values.yaml and add a comment pointing at #inc-4417.')
  t.bash('git checkout -b fix/consumer-poll-records-env && git log --oneline -3 -- deploy/consumer', `Switched to a new branch 'fix/consumer-poll-records-env'\n3f9a2c1 tune poll for memory\n9e01b77 consumer: bump to 8.14.0\n51c0d3e consumer: add readiness gate`)
  t.edit('deploy/consumer/templates/deployment.yaml', '              value: "50"   # hard-coded in 8.14.0, see commit 3f9a2c1', '              value: {{ .Values.consumer.maxPollRecords | quote }}')
  t.read('deploy/consumer/values.yaml', `image:\n  tag: 8.14.0\nconsumer:\n  replicas: 12\n  maxPollRecords: 50\n  group: ingest-main\n${logLines(76, 12, 'values')}`, 'Template patched. Now the default in values.yaml.')
  return {
    name: 'incident',
    topic: 'the Kestrel consumer lag incident',
    messages: t.messages,
    split: 'dev',
    about: 'An incident that opens with an earlier summary: facts to carry over, one of them overtaken, a first fix that failed.',
    probes: [
      { id: 'goal', kind: 'goal', q: 'What is the incident about (which topic, what symptom)?', accept: [/lag/i, /ingest\.events\.v3/], src: 'ingest.events.v3' },
      { id: 'no-brokers', kind: 'instruction', q: 'What must I not do to the brokers, and why?', accept: [/restart/i, /approver|approval/i], src: 'second approver' },
      { id: 'approval', kind: 'instruction', q: 'What does the user require before I run a command that changes the cluster?', accept: [/show|approv|confirm/i], src: 'shown to them before I run it' },
      { id: 'no-rollback', kind: 'rejected', q: 'Why was a full rollback of the release ruled out?', accept: [/security|CVE|TLS/i], src: 'security fix (CVE patch in the TLS library)' },
      { id: 'versions', kind: 'value', q: 'Which consumer version was deployed, and which was the previous one?', accept: [/8\.14\.0/, /8\.13\.2/], src: 'previous: 8.13.2' },
      { id: 'first-fix', kind: 'error', q: 'The Helm override was applied first. Why did it not work?', accept: [/env|KESTREL_MAX_POLL_RECORDS|hard-?coded/i], src: 'the environment variable wins over the file' },
      { id: 'real-fix', kind: 'decision', q: 'What finally made the lag go down?', accept: [/set env|KESTREL_MAX_POLL_RECORDS(=| to )?500|environment variable/i], src: 'kubectl -n ingest set env deployment/kestrel-consumer KESTREL_MAX_POLL_RECORDS=500' },
      { id: 'page', kind: 'value', q: 'At what lag does the user have to page someone, and whom?', accept: [/2 ?(million|M)|2,000,000/i, /data platform/i], src: 'page the data platform lead' },
      { id: 'peak', kind: 'value', q: 'What was the peak lag observed?', accept: [/1,304,117|1\.3 ?M|1304117|1\.30/i], src: 'TOTAL LAG: 1,304,117' },
      { id: 'durability', kind: 'decision', q: 'Why is the kubectl fix not durable, and what is the durable fix?', accept: [/helm|overwrit|next upgrade/i, /template|chart|PR/i], src: 'Helm will overwrite it on the next upgrade' },
      { id: 'branch', kind: 'identifier', q: 'What is the branch name for the chart fix?', accept: [/fix\/consumer-poll-records-env/], src: 'Branch name fix/consumer-poll-records-env' },
      { id: 'handle', kind: 'identifier', q: "Whom should the draft PR tag (the user's handle)?", accept: [/@?rosalind-ek/], src: '@rosalind-ek' },
      { id: 'channel', kind: 'identifier', q: 'What is the incident channel to reference?', accept: [/#?inc-4417/], src: '#inc-4417' },
      { id: 'todo', kind: 'state', q: 'What exactly remains to be done in values.yaml?', accept: [/500/, /comment|inc-4417/i], src: 'Keep the default at 500 in values.yaml' },
      { id: 'commit', kind: 'identifier', q: 'Which commit hard-coded the poll setting?', accept: [/3f9a2c1/], src: 'commit 3f9a2c1' },
      { id: 'revision', kind: 'value', q: 'Which Helm revision did the override deploy?', accept: [/\b57\b/], src: 'REVISION: 57' },
      { id: 'pods', kind: 'value', q: 'How many consumer pods are there?', accept: [/\b12\b|twelve/i], src: 'All 12 pods are running' },
      { id: 'drain-rate', kind: 'value', q: 'How fast did the backlog drain once the fix was in?', accept: [/120 ?k|120[,.]?000/i], src: 'about 120k events a minute' },
      { id: 'helm-flags', kind: 'instruction', q: 'What did the user ask me to add to the helm upgrade command before approving it?', accept: [/atomic/i, /\b5[- ]?m|five[- ]minute/i], src: 'add --atomic' },
      { id: 'early-lag', kind: 'value', q: 'What was the lag at 14:20 and at 14:50?', accept: [/310 ?k|310[,.]?000/i, /780 ?k|780[,.]?000/i], src: 'Lag was 310k events at 14:20 and 780k at 14:50' },
      { id: 'lead-name', kind: 'never-stated', q: 'What is the name of the data platform lead?', accept: [] },
      { id: 'postmortem-date', kind: 'never-stated', q: 'When is the postmortem meeting?', accept: [] },
      { id: 'dashboard', kind: 'never-stated', q: 'What is the URL of the lag dashboard?', accept: [] },
    ],
  }
}

const STORIES: Story[] = [flakyTest(), rateLimiter(), salesAnalysis(), migration(), docsRewrite(), incident()]
const story = (name: string) => STORIES.find(s => s.name === name)!

/** One task, padded to the size its theme gives. */
function single(s: Story, seed: number): Fixture {
  return { name: s.name, split: s.split, about: s.about, messages: pad(s.messages, THEMES[s.name]!, seed), probes: s.probes }
}

/**
 * Several tasks in one session, one after the other, as a long working day
 * goes: the summary has one word budget for all of them, so it has to choose.
 * Each question names the task it is about.
 */
function session(name: string, split: Fixture['split'], names: string[], charsEach: number): Fixture {
  const stories = names.map(story)
  return {
    name,
    split,
    about: `One long session: ${names.join(', then ')}.`,
    messages: stories.flatMap((s, i) => {
      const padded = pad(s.messages, { ...THEMES[s.name]!, targetChars: charsEach }, 10 + i)
      if (i === 0) return padded
      const first = padded.findIndex(m => m.role === 'user' && m.text !== '')
      return padded.map((m, j) => (j === first ? { ...m, text: `Next task, in a different repository. ${m.text}` } : m))
    }),
    probes: stories.flatMap(s => s.probes.map(probe => ({ ...probe, id: `${s.name}/${probe.id}`, q: `About ${s.topic}: ${probe.q}` }))),
  }
}

export const FIXTURES: Fixture[] = [
  ...STORIES.map((s, i) => single(s, i + 1)),
  // The incident opens with an earlier summary, which only the head of a conversation can hold.
  session('long-dev', 'dev', ['incident', 'flaky-test', 'migration'], 100_000),
  session('long-held-out', 'held-out', ['sales-analysis', 'docs-rewrite', 'rate-limiter'], 100_000),
]
