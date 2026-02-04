# E2E Tests for Kata Agents

End-to-end tests using Playwright with Electron support.

## Quick Start

```bash
# From apps/electron directory

# Run all e2e tests
bun run test:e2e

# Run with UI (interactive mode)
bun run test:e2e:ui

# Run in debug mode
bun run test:e2e:debug
```

## Prerequisites

1. **Build the app first** - Tests run against the built Electron app:
   ```bash
   bun run build
   ```

2. **Test mode** - Tests automatically set `KATA_TEST_MODE=1` to:
   - Use mock API responses
   - Use isolated test workspace
   - Skip real Claude API calls

## Directory Structure

```
e2e/
├── fixtures/           # Test fixtures (app launch, workspace, mocks)
│   ├── electron.fixture.ts
│   ├── test-workspace.ts
│   └── mock-api.ts
├── page-objects/       # Page Object Model classes
│   ├── ChatPage.ts
│   └── WorkspacePage.ts
├── tests/              # Test specs
│   ├── app-launch.spec.ts
│   └── session-lifecycle.spec.ts
├── helpers/            # Utility functions
│   └── test-utils.ts
└── screenshots/        # Debug screenshots (gitignored)
```

## Writing Tests

### Using Fixtures

```typescript
import { test, expect } from '../fixtures/electron.fixture'

test('my test', async ({ electronApp, mainWindow }) => {
  // electronApp - Playwright Electron handle
  // mainWindow - Page object for the main window
})
```

### Using Page Objects

```typescript
import { test, expect } from '../fixtures/electron.fixture'
import { ChatPage } from '../page-objects/ChatPage'

test('send message', async ({ mainWindow }) => {
  const chatPage = new ChatPage(mainWindow)
  await chatPage.sendMessage('Hello')
  await chatPage.waitForResponse()
})
```

## Live Tests (Real Credentials)

Live tests use the demo environment (`~/.kata-agents-demo/`) with real OAuth credentials from `~/.kata-agents/credentials.enc`. They exercise the full auth path with no mocking.

### Setup

```bash
# From monorepo root

# Seed demo environment (config, workspace, sessions, skills, sources)
bun run demo:setup

# Create demo git repo at ~/kata-agents-demo-repo/
bun run demo:repo

# Or do both and launch the app in dev mode
bun run demo:launch
```

### Writing Live Tests

Use `live.fixture.ts` instead of `electron.fixture.ts`:

```typescript
import { test, expect } from '../fixtures/live.fixture'

test('send real message', async ({ mainWindow }) => {
  // This hits the real Claude API -- use longer timeouts
  const chatPage = new ChatPage(mainWindow)
  await chatPage.sendMessage('Say hello')
  await chatPage.waitForResponse({ timeout: 30_000 })
})
```

Key differences from mock tests:
- No `KATA_TEST_MODE` env var (real auth path)
- `KATA_CONFIG_DIR` points to `~/.kata-agents-demo/`
- Demo directory persists across test runs (not cleaned up)
- Longer default timeouts for real API calls
- Requires valid OAuth credentials in `~/.kata-agents/credentials.enc`

### Demo Commands

| Command | Description |
|---------|-------------|
| `bun run demo:setup` | Seed demo environment (no-op if exists) |
| `bun run demo:reset` | Wipe and recreate demo environment |
| `bun run demo:launch` | Setup + launch app in dev mode |
| `bun run demo:repo` | Create demo git repo (no-op if exists) |

### Demo Environment

The demo setup creates:

```
~/.kata-agents-demo/
├── config.json                    # Global config (oauth_token auth)
└── workspaces/demo-workspace/
    ├── config.json                # Workspace config
    ├── sessions/                  # 4 seeded sessions
    │   ├── 260201-bright-meadow/  # Code Review (in-progress, flagged)
    │   ├── 260201-swift-river/    # API Integration (todo)
    │   ├── 260202-quiet-forest/   # Debug Session (needs-review)
    │   └── 260202-golden-dawn/    # Quick Question (done)
    ├── sources/filesystem/        # Filesystem MCP source
    ├── skills/                    # Copied from project skills/
    ├── statuses/                  # Default status config
    ├── labels/                    # Default label config
    └── .claude-plugin/            # Plugin manifest

~/kata-agents-demo-repo/           # Separate demo git repo (working dir)
```

Auth works because `credentials.enc` is read from the hardcoded path `~/.kata-agents/credentials.enc` regardless of `KATA_CONFIG_DIR`.

### Running Live Tests

**Prerequisites:**
- Valid OAuth credentials in `~/.kata-agents/credentials.enc` (authenticate via the app first)
- The fixture validates credentials exist and provides a clear error if missing

**Scripts:**

```bash
# From apps/electron directory

# Run all live tests
bun run test:e2e:live

# Run live tests in debug mode (step-through debugging)
bun run test:e2e:live:debug

# Run live tests in headed mode (watch execution)
bun run test:e2e:live:headed
```

**Notes:**
- Live tests are in `e2e/tests/live/` and use `live.fixture.ts`
- They exercise the real Claude API and take longer than mock tests
- Use longer timeouts (30s+) for API calls

## Configuration

See `playwright.config.ts` for:
- Timeout settings
- Retry configuration
- Reporter options
- Trace/video capture settings

## CI Integration

E2E tests are available in CI but disabled by default (macOS runners are expensive).
To enable, uncomment the `e2e-tests` job in `.github/workflows/ci.yml`.

## Debugging Failed Tests

1. **Screenshots** - Automatically captured on failure
2. **Videos** - Retained on failure (see `playwright-report/`)
3. **Traces** - Captured on first retry
4. **Debug mode** - Run `bun run test:e2e:debug` for step-through debugging
