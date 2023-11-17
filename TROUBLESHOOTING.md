# Troubleshooting

## Installation

### Compiler Issues
Currently a number of ENiGMA½'s NPM dependencies include modules that require C bindings, and thus, may need compiled uf prebuilt binaries are not available on NPM for your system/architecture. This is often the case for older Linux systems, some ARM devices, etc.

**Example**: Compiling `sqlite3` from source with `npm`:
```bash
npm rebuild --build-from-source sqlite3
```

With `yarn`:
```bash
env npm_config_build_from_source=true yarn install sqlite3
```

If you get compiler errors when running `npm install` or `yarn`, you can try rebuilding with compiler overrides.

**Example**: Overriding compilers for `node-pty` compilation:

```bash
env CC=gcc CXX=gcc npm rebuild --build-from-source node-pty
```

## Upgrades

### Missing Menu & Theme Entries
One thing to be sure and check after an update is your menu/prompt HJSON configurations as well as your theme(s). The default templates are updated alongside features, but you may need to merge in fragments missing from your own.

See also [Updating](./docs/_docs/admin/updating.md)