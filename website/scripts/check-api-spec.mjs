//  Fail if the OpenAPI spec and the running API have drifted apart.
//
//  docs/api/openapi.yaml is hand-maintained. Nothing stops a route being added
//  to core/rest/routes/ without a matching spec entry, and a reference that
//  quietly omits an endpoint is worse than no reference: readers trust it.
//
//  Rather than parse the route source -- brittle, and it breaks silently the
//  moment the registration shape changes -- this loads the real route modules
//  and hands them a stub web server that records what they register. That is
//  the actual route table the BBS would serve, with no guessing. The modules
//  import app internals but do not touch the database at load, so they can be
//  required outside a running system.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROUTES_DIR = resolve('../core/rest/routes');
const SPEC = 'src/api/openapi.yaml';

//  ---- what the code registers -------------------------------------------
const registered = [];
const stubServer = { addRoute: r => registered.push(r) };
const stubLog = new Proxy({}, { get: () => () => {} });

for (const file of readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js'))) {
    const mod = require(resolve(ROUTES_DIR, file));
    if (typeof mod.register !== 'function') continue;
    mod.register(stubServer, stubLog);
}

/** Turn a route RegExp into the path shape the spec uses. */
function routeToPath(re) {
    let p = re.source
        .replace(/^\^/, '')
        .replace(/\(\?:\[\?#\]\|\$\)$/, '') //  the optional query/fragment tail
        .replace(/\$$/, '')
        .replace(/\\\//g, '/');
    //  Any capture group is a path parameter, whatever it matches.
    p = p.replace(/\([^)]*\)(\{\d+(,\d+)?\})?/g, '{param}');
    return p.replace(/\/$/, '') || '/';
}

//  The spec declares its base under servers[].url; routes carry it inline.
const specText = readFileSync(SPEC, 'utf8');
const baseMatch = specText.match(/^\s*-\s*url:\s*(\S+)\s*$/m);
const base = baseMatch ? baseMatch[1] : '';

const inCode = new Set(
    registered.map(r => {
        const path = routeToPath(r.path).replace(base, '') || '/';
        return `${r.method.toUpperCase()} ${path}`;
    })
);

//  ---- what the spec declares --------------------------------------------
const inSpec = new Set();
let current = null;
for (const line of specText.split('\n')) {
    const path = line.match(/^ {2}(\/\S*):\s*$/);
    if (path) {
        current = path[1];
        continue;
    }
    const op = line.match(/^ {4}(get|post|put|patch|delete):\s*$/);
    if (op && current)
        inSpec.add(`${op[1].toUpperCase()} ${current.replace(/\{\w+\}/g, '{param}')}`);
    //  A new top-level key ends the paths block.
    if (/^\S/.test(line)) current = null;
}

//  ---- diff ---------------------------------------------------------------
const missing = [...inCode].filter(r => !inSpec.has(r)).sort();
const extra = [...inSpec].filter(r => !inCode.has(r)).sort();

if (!missing.length && !extra.length) {
    console.log(`api spec check: ${inCode.size} routes, spec matches the implementation`);
    process.exit(0);
}
console.error('api spec check: the OpenAPI spec has drifted from core/rest/routes/\n');
if (missing.length) {
    console.error(`  served but undocumented (${missing.length}) — add to ${SPEC}:`);
    for (const r of missing) console.error(`    ${r}`);
}
if (extra.length) {
    console.error(
        `\n  documented but not served (${extra.length}) — remove from ${SPEC}:`
    );
    for (const r of extra) console.error(`    ${r}`);
}
process.exit(1);
