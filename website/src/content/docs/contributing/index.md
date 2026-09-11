---
title: Contributing
description: "Where the style guide, architecture notes and development setup live, and how to work on these docs."
sidebar:
    order: 1
---
Contributions are welcome — code, documentation, art, or a bug report that saves
someone else the afternoon you just lost.

## Before You Start

Three documents cover the ground, and they live in the repository rather than
here because they describe the source tree you will have checked out:

| Document | Covers |
|----------|--------|
| [CONTRIBUTING.md](https://github.com/NuSkooler/enigma-bbs/blob/master/CONTRIBUTING.md) | Style and formatting, the `async` flow-control convention, error handling and logging, and what a good PR looks like |
| [DEV.md](https://github.com/NuSkooler/enigma-bbs/blob/master/DEV.md) | Internal architecture — the art and theme pipeline, the menu module pattern, the view system, and how configuration reaches a module |
| [Development Environment](development.md) | Getting a working checkout, and the editor tasks that come with it |

Two conventions catch people out often enough to repeat here:

* **Production code uses [`async`](https://caolan.github.io/async/), not Promises.**
  `async`/`await` is fine in tests, but not in `core/` or `mods/`.
* **Update `WHATSNEW.md` for anything user-visible, and `UPGRADE.md` for anything
  breaking.** Those are what a sysop reads on upgrade day.

## Working on the Documentation

These docs are an [Astro](https://astro.build) + [Starlight](https://starlight.astro.build)
site under `website/` in the same repository. Each page is a markdown file in
`website/src/content/docs/`, and there is an **Edit page** link at the bottom of
every page that takes you straight to it on GitHub.

To run the site locally:

```bash
cd website
npm install
npm run dev      # http://localhost:4321
```

Before opening a documentation PR:

```bash
npm run verify
```

That builds the site and then runs three checks, each of which fails the build
rather than warning:

* **Links** — every internal link resolves to a page that was actually built.
* **Navigation** — every page that was built is reachable from the sidebar.
* **API spec** — the OpenAPI document still matches the routes the server registers.

A few conventions specific to this site:

* Link between docs with **relative `.md` paths** (`../art/mci.md`). They work as
  written on GitHub, and a remark plugin rewrites them to routes for the site.
  An absolute path works in neither place.
* Give every page a `title` and a one-line `description` in frontmatter, plus a
  `sidebar.order` — sections are otherwise alphabetical.
* Do not repeat the page title as the first heading; Starlight renders the
  frontmatter title as the page's H1 already. Body headings start at `##`.
* Use Starlight's admonitions (`:::note`, `:::tip`, `:::caution`) rather than raw
  HTML, and plain fenced code blocks rather than `<details markdown="1">`, which
  is a Jekyll idiom that does not render here.

## Getting in Touch

* [Discussions](https://github.com/NuSkooler/enigma-bbs/discussions) and the [issue tracker](https://github.com/NuSkooler/enigma-bbs/issues)
* [Discord](https://discord.gg/M2pbyvuGva)
* `FSX_ENG` on [fsxNet](https://fsxnet.nz)
