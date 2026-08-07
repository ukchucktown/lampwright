# skill-cleaner

`skill-cleaner` is a cross-platform terminal tool for finding and safely removing AI agent skills regardless of how they were installed.

The project is currently in specification and planning. See:

- [Domain language](./CONTEXT.md)
- [Product specification](./docs/spec.md)
- [Module design](./docs/module-design.md)
- [Core model](./docs/model.md)
- [Inventory scanning](./docs/inventory.md)
- [Adapter runtime](./docs/adapters.md)
- [Removal planning](./docs/planning.md)
- [Implementation roadmap](./docs/roadmap.md)
- [Architectural decisions](./docs/adr/)

The intended interface is:

```console
npx skill-cleaner
```

## Status

No implementation has been released. Work is tracked in the repository's GitHub issues.

## Development

The project requires Node.js 20 or newer. Install dependencies with `npm install`, then
run the local quality gates:

```console
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

After building, inspect the executable scaffold with:

```console
node dist/cli.js --help
node dist/cli.js --version
```

## License

MIT
