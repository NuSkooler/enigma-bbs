//  Validate the hjson examples in the docs against the real config schema.
//
//  Two config keys in these docs were simply wrong: web-server.md documented
//  `enable` where the code reads `enabled`, and gopher.md's example used
//  `messageConferences`, deprecated and shaped differently from the
//  `exposedConfAreas` its own table described. Both had been wrong for years,
//  because nothing connects a fenced example to the schema it claims to show.
//
//  ENiGMA½ already knows how to find these -- `oputil.js config validate` does
//  it for a sysop's real configuration, and core/config/meta.js already models
//  which sections hold sysop data (area tags, node addresses) rather than
//  setting names, so those are not reported as typos. This runs the same
//  validator over the documentation's examples.
//
//  Only fragments rooted at a real config.hjson section are checked. Most hjson
//  in these docs is menu.hjson, theme.hjson or a view's MCI block, and a partial
//  fragment starting mid-tree cannot be placed. Those are skipped, and the
//  summary says how many.
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const DOCS = 'src/content/docs';
const REPO = '..';

//  Top-level sections of config.hjson. A fence starting with one of these is a
//  system config fragment; anything else is menu, theme or illustrative.
const CONFIG_ROOTS = new Set(
    Object.keys(
        (
            await import(`file://${join(process.cwd(), REPO, 'core/config_default.js')}`)
        ).default()
    )
);

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.md')) out.push(full);
    }
    return out;
}

/**
 * Fenced hjson blocks, with the line the fence opened on and the prose just
 * above it. Some menu and theme sections share a name with a config.hjson
 * section -- `sysopChat` is both -- so the root key alone cannot tell them
 * apart. What the surrounding sentence says the example *is* can.
 */
function* fences(md) {
    const lines = md.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*```hjson\s*$/.test(lines[i])) continue;
        const body = [];
        let j = i + 1;
        for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++)
            body.push(lines[j]);
        yield {
            line: i + 1,
            body: body.join('\n'),
            lead: lines.slice(Math.max(0, i - 6), i).join(' '),
        };
        i = j;
    }
}

//  Said of an example, these mean it is not a config.hjson fragment.
const NOT_CONFIG =
    /\b(menu|theme|prompt)\.hjson\b|\bMCI\b|\btheme block\b|\bmenu entry\b/i;

/**
 * Strip the outer braces some examples wrap their fragment in, and report the
 * first top-level key so we can tell config from menu/theme.
 */
function normalise(body) {
    let src = body.trim();
    if (src.startsWith('{') && src.endsWith('}')) src = src.slice(1, -1).trim();
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/m.exec(src);
    return { src, root: m ? m[1] : null };
}

const tmp = mkdtempSync(join(tmpdir(), 'enigma-docs-cfg-'));
const findings = [];
let checked = 0;
let skipped = 0;

for (const file of walk(DOCS)) {
    const md = readFileSync(file, 'utf8');
    for (const { line, body, lead } of fences(md)) {
        const { src, root } = normalise(body);
        if (!root || !CONFIG_ROOTS.has(root) || NOT_CONFIG.test(lead)) {
            skipped++;
            continue;
        }
        //  Examples elide surrounding context with a comment; the parse would
        //  fail on the ellipsis rather than tell us anything useful.
        if (/^\s*\/\/\s*\.\.\./m.test(src) || /\.\.\.\s*$/m.test(src)) {
            skipped++;
            continue;
        }

        writeFileSync(join(tmp, 'config.hjson'), src + '\n');
        let out = '';
        try {
            out = execFileSync(
                process.execPath,
                //  oputil concatenates --config with 'config.hjson' rather than
                //  joining, so the trailing separator is required.
                ['oputil.js', 'config', 'validate', '--config', tmp + sep],
                { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
            );
        } catch (err) {
            out = `${err.stdout || ''}${err.stderr || ''}`;
        }
        checked++;

        //  Only the block about our temp file, and only unknown-key warnings:
        //  an example is a fragment, so "missing required" is expected noise.
        const mine = out.slice(
            0,
            out.indexOf('\n\n\n') === -1 ? undefined : out.indexOf('\n\n\n')
        );
        for (const m of mine.matchAll(/^\s*(warning|error)\s+(\S+)\n\s+(.+)$/gm)) {
            if (!/unknown key|did you mean|expected/.test(m[3])) continue;
            findings.push({
                file: relative('.', file),
                line,
                level: m[1],
                path: m[2],
                message: m[3].trim(),
            });
        }
    }
}

rmSync(tmp, { recursive: true, force: true });

console.log(
    `config examples: ${checked} checked, ${skipped} skipped (menu, theme or partial), ${findings.length} issue(s)`
);

if (findings.length === 0) process.exit(0);

console.error('');
for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.level}`);
    console.error(`    ${f.path}\n    ${f.message}\n`);
}
console.error(
    'These are documentation examples that would not validate as real config.\n' +
        'Check the key against core/config_default.js or core/config/meta.js.'
);
process.exit(1);
