# Contributing

## Running the suite

```bash
npm install
npm test         # node --test src/*.test.ts — 526 tests, no framework
npm run typecheck   # tsc --noEmit
npm run check       # syntax check, then the suite
```

`npm run check` is the fast gate — `tsc --noEmit --noCheck` (syntax only) followed by the
tests. Use `npm run typecheck` for the full type check; CI runs both.

A single file, when you are iterating on one:

```bash
node --test src/decide.test.ts
```

## There is no build step

The plugin runs **unbuilt**. opencode's bundled runtime executes the TypeScript directly
via node's strip-only type stripping, so there is nothing to compile, no bundler, and no
`dist/`. `tsc` is used for checking types and never for emitting — `noEmit` is set in
`tsconfig.json`.

Two consequences worth knowing before you write code here:

- **Node must be ≥ 23.6** (24 recommended, and what CI uses). Strip-only TypeScript landed
  there; `engines` in `package.json` says the same.
- **Anything needing real transpilation is illegal.** Type stripping erases annotations and
  nothing else, so TypeScript features that emit runtime code cannot be used. In practice
  that means **no parameter properties** (`constructor(private x: string)`), no `enum`, and
  no decorators — they parse and then fail at runtime. Write the plain-JavaScript form and
  annotate it.

## Restart opencode after every change

Plugins load **once at opencode startup and there is no hot reload**. An edit you have
saved is not an edit the running server has: it will keep serving the version it loaded,
which is the single most expensive way to lose an hour here. Restart the server to pick up
changes.

If the plugin fails to load, opencode starts anyway and swallows the error — check the
opencode log rather than assuming a silent start means a clean one.

## Where things belong

The rule the design rests on: **anything that decides an outcome lives in `src/decide.ts`
and is tested.** `src/engine.ts` may move data and call models, but a judgement written
there belongs one file over. The same split holds elsewhere — `src/schedule.ts` and
`src/crew-org.ts` are pure and heavily tested; the code that talks to models is not, and
cannot be.

No test in this suite may call a model. Anything that would requires a seam and a fake.

## Tests and comments

- A test's name says what must hold, not which function it calls.
- Comments explain **why**, especially when they record a measurement or a past failure —
  the date and the number are the point. Read a few files before writing new ones; the
  voice is consistent and deliberate.
- Do not add comments that restate the code.

## Design record

- **[PLAN.md](./PLAN.md)** — design decisions with rationale, measured spike results, and
  the opencode runtime gotchas that cost real time to find. Read it before changing the
  architecture.
- **[docs/adr/](./docs/adr/)** — one file per decision, named `YYYY-MM-DD-slug.md`. Dates
  and slugs rather than sequential numbers, because two workers deciding concurrently both
  allocate the same `0007-`.
- **[CHANGELOG.md](./CHANGELOG.md)** — Keep a Changelog format; add to `[Unreleased]`.

## Before you open a PR

`npm run check` and `npm run typecheck` both clean. If the change touches the harness
gate, the guard, or anything under `src/decide.ts`, say in the PR what you measured rather
than what you expect — this repo draws a hard line between "it held" and "nobody looked".
