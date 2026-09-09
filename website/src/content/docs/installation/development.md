---
title: Development Environment Setup
description: "Set up a development environment for working on ENiGMA½ itself, via the VS Code dev container."
sidebar:
    order: 10
---
_Note:_ This is only useful for people who are looking to contribute to the ENiGMA½ source base itself. Those that are just setting up a new BBS system do not need this section.

The easiest way to get started with development on ENiGMA½ is via the pre-configured Visual Studio Code remote docker container environment. This setup will download and configure everything needed with minimal interaction. It also works cross-platform.

* Install [Visual Studio Code](https://code.visualstudio.com/download)
* Install [Docker](https://docs.docker.com/engine/install/)
* Clone the [ENiGMA½](https://github.com/NuSkooler/enigma-bbs) repository.
* Choose "Open Folder" from Visual Studio Code and open the location where you cloned the repository.

That's it! Visual Studio Code should prompt you for everything else that is needed, including some useful extensions for development.

## Tasks

Once it completes, there are a few tasks and run-configs that are useful.  Open up the command pallete and search/choose "Tasks> Run Task". From there you can run the following tasks:

### Start docs site (Astro dev server)

Starts the documentation site's dev server for local testing of documentation changes. After running this task, open a browser to <http://localhost:4321> to see the docs with live reload as you edit.

### Build docs site

Runs `npm run verify` in `website/` — a production build followed by the internal link check and the OpenAPI spec check. Run this before opening a documentation PR; CI runs the same thing.

### (re)build docs site node modules

Re-installs the documentation site's dependencies under `website/`. Generally unnecessary unless something is broken or you are changing versions.

### (re)build node modules

Used to re-generate the node modules. Generally shouldn't be necessary unless something is broken or you are adding/changing versions of dependencies.

### ENiGMA½ new configuration

This task executes `oputil.js` in order to create a new BBS configuration (useful if you have just checked out the code and haven't setup any configuration yet.)

## Run / Debug config

There is also a default "Launch Program" config (hotkey access via F5 / Ctrl-Shift-D.) This will launch ENiGMA½. Once it has launched, access the system via telnet, port 8888 as usual.