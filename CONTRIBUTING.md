# Contributing to EmberImage

Thanks for taking the time to contribute! EmberImage is a local-first desktop client for AI image generation. It aims to stay small, dependency-light, and easy to audit.

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.html) spirit — be respectful, constructive, and kind.

## How to contribute

### 1. Report a bug or request a feature

Open an issue using the appropriate template:

- 🐛 **Bug report** — describe what you expected vs. what happened, plus the steps to reproduce. Include the OS, the interface type (OpenAI-compatible / Seedream / Gemini), and any relevant logs.
- ✨ **Feature request** — explain the problem you're trying to solve and how you'd expect it to behave.

Before opening a new issue, please search the existing issues and the README to avoid duplicates.

### 2. Propose a change

For non-trivial changes, please open an issue or discussion **first** to align on the approach before writing code.

#### Workflow

1. Fork the repository and create a branch from `main` (`git checkout -b feat/your-change`).
2. Make your changes.
3. Run the checks locally (see below).
4. Commit with a clear, imperative message.
5. Open a pull request against `main` using the PR template.

#### Local setup

Requires **Node.js 20+** (managed runtime). There are **zero npm runtime dependencies** — do not add new ones.

```bash
npm install
npm start      # launch the app
```

#### Verify before pushing

```bash
npm run check   # static syntax check across main, preload, renderer, worker and shared
npm test        # run the full test suite (Node built-in node --test)
```

Both must pass with **no errors**. If you touch provider adapters, add or update tests under `test/`.

### Code style & architecture notes

- Pure **CommonJS + native JS**. No frameworks, no build step, no bundlers.
- `src/shared/` holds pure logic and provider adapters shared by both the main and renderer processes; keep platform/Electron concerns out of it.
- To add a new image API, create an adapter in `src/shared/providers/` implementing the unified `endpoints / headers / buildGenerationBody / buildEditBody / parseResponse` interface and register it in `src/shared/providers/index.cjs`.
- Keep the codebase auditable: no obfuscation, clear names, and comments where behavior is non-obvious.
- Preserve the privacy guarantees: **never** let an API Key, image Base64 payloads, or full local paths reach logs.

### Commit & release conventions

- One logical change per commit; prefix messages with the scope when useful (e.g. `providers:`, `mask:`, `ui:`).
- Releases are cut by the maintainer following [`docs/RELEASING.md`](docs/RELEASING.md) — you don't need to bump versions or write release notes yourself.

## Getting help

If you're unsure about anything, open a discussion or ask in the issue thread — no question is too small.
