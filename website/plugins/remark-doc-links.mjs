//  Rewrites relative markdown links to built routes, and fails the build on a
//  target that does not exist.
//
//  The docs are read in two places: as markdown in the repo, and as a rendered
//  site. Relative `.md` links are the only form that works in both — GitHub
//  follows them directly, and this plugin turns them into routes for the site.
//  Jekyll did the first half via jekyll-relative-links; nothing in Starlight
//  does it, so without this every doc-to-doc link 404s.
//
//  The second half is the part that matters long-term: an unresolvable link is
//  a build error, not a silently shipped 404. The old site accumulated ~20 of
//  those precisely because nothing ever failed.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { visit } from 'unist-util-visit';

const CONTENT_ROOT = path.resolve('src/content/docs');
const MD = /\.(md|markdown|mdx)$/i;

/** @param {{ strict?: boolean }} opts */
export function remarkDocLinks({ strict = true } = {}) {
    return (tree, file) => {
        const self = file.path ?? file.history?.[0];
        if (!self) return;
        const fromDir = path.dirname(self);
        const broken = [];

        visit(tree, 'link', node => {
            const url = node.url;
            if (!url) return;
            //  Leave protocol-relative, absolute and pure-anchor links alone.
            if (
                /^[a-z][a-z0-9+.-]*:/i.test(url) ||
                url.startsWith('//') ||
                url.startsWith('#')
            )
                return;

            const [target, ...rest] = url.split('#');
            const hash = rest.length ? '#' + rest.join('#') : '';
            if (!MD.test(target)) return;

            //  Root-relative .md links cannot work in either context.
            const abs = target.startsWith('/')
                ? path.join(CONTENT_ROOT, target)
                : path.resolve(fromDir, target);

            if (!existsSync(abs) || !abs.startsWith(CONTENT_ROOT)) {
                broken.push(url);
                return;
            }

            let route = path
                .relative(CONTENT_ROOT, abs)
                .split(path.sep)
                .join('/')
                .replace(MD, '');
            if (route === 'index') route = '';
            else if (route.endsWith('/index')) route = route.slice(0, -'/index'.length);

            node.url = '/' + (route ? route + '/' : '') + hash;
        });

        if (broken.length) {
            const rel = path.relative(CONTENT_ROOT, self);
            const msg =
                `[doc-links] ${rel} links to ${broken.length} target(s) that do not exist:\n` +
                broken.map(b => `    ${b}`).join('\n');
            if (strict) throw new Error(msg);
            console.warn(msg);
        }
    };
}
