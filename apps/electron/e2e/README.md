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
