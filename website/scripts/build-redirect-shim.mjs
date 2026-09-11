//  Build the redirect shim for the old documentation URLs.
//
//  The docs lived at https://nuskooler.github.io/enigma-bbs/<path>.html since
//  2018. They now live at https://enigma-bbs.github.io/<path>/ -- a different
//  host AND a different path shape. Every deep link in a forum post, a wiki, or
//  a search result would break.
//
//  Two layers, because they fail differently:
//
//    * A stub per page. Returns HTTP 200 with a <link rel="canonical"> to the
//      new URL, so search engines treat it as moved and carry the ranking over,
//      plus a meta refresh so people are actually taken there.
//    * A catch-all 404. GitHub Pages serves 404.html for anything unmatched, so
//      one file with a path mapper covers URLs no stub was generated for: old
//      assets, paths that changed before the move, near-miss typos. It is
//      served with a 404 status, which is why it cannot replace the stubs.
//
//  Output goes to shim/, which is published to this repository's gh-pages --
//  replacing the docs that used to live there. The old content stays one
//  `git revert` away on a branch we still control.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DIST = 'dist';
const OUT = 'shim';
const NEW_ORIGIN = 'https://enigma-bbs.github.io';
//  Where the old site was served from, as a path prefix.
const OLD_BASE = '/enigma-bbs';

/** Every route the new site publishes, as `/foo/bar/`. */
function routes(dir = DIST, base = '/') {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...routes(full, `${base}${name}/`));
        else if (name === 'index.html') out.push(base);
    }
    return out;
}

const stub = target => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Moved — ENiGMA½ BBS documentation</title>
    <link rel="canonical" href="${target}" />
    <meta http-equiv="refresh" content="0; url=${target}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <p>The ENiGMA½ documentation has moved. This page is now at
      <a href="${target}">${target}</a>.</p>
  </body>
</html>
`;

rmSync(OUT, { recursive: true, force: true });

const all = routes();
let written = 0;
for (const route of all) {
    const target = `${NEW_ORIGIN}${route}`;
    //  Both old shapes: the site published `foo/bar.html` for most pages and
    //  `foo/index.html` where the source file was itself an index.
    const paths =
        route === '/'
            ? ['index.html']
            : [`${route.slice(1, -1)}.html`, `${route.slice(1)}index.html`];
    for (const p of paths) {
        const file = resolve(OUT, p);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, stub(target));
        written++;
    }
}

//  Catch-all. Rewrites /enigma-bbs/a/b.html -> https://enigma-bbs.github.io/a/b/
writeFileSync(
    join(OUT, '404.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Moved — ENiGMA½ BBS documentation</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script>
      //  Map an old documentation URL onto its new home.
      (function () {
        var base = ${JSON.stringify(OLD_BASE)};
        var origin = ${JSON.stringify(NEW_ORIGIN)};
        var p = location.pathname;
        if (p.indexOf(base) === 0) p = p.slice(base.length);

        if (/index\\.html$/.test(p)) {
          p = p.replace(/index\\.html$/, '');
        } else if (/\\.html$/.test(p)) {
          p = p.replace(/\\.html$/, '/');
        } else if (/\\.[a-z0-9]+$/i.test(p)) {
          //  An asset rather than a page -- old images and the like were
          //  content-hashed on the way over, so there is no path to map onto.
          //  The site root beats a guaranteed 404.
          p = '/';
        }
        if (p && p.charAt(p.length - 1) !== '/') p += '/';
        location.replace(origin + (p || '/'));
      })();
    </script>
  </head>
  <body>
    <p>The ENiGMA½ documentation has moved to
      <a href="${NEW_ORIGIN}/">${NEW_ORIGIN}</a>.</p>
  </body>
</html>
`
);
//  Without this, GitHub Pages runs the output through Jekyll.
writeFileSync(join(OUT, '.nojekyll'), '');

console.log(
    `redirect shim: ${written} stubs for ${all.length} pages, plus a catch-all 404`
);
