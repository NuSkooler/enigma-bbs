---
layout: page
title: Development Environment Setup
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

### Start Jekyll (ENiGMA½ documentation server)

This task will start the Jekyll server to perform local testing of changes to documentation. After running this task, open a browser to (http://localhost:4000/enigma-bbs/) to see the documentation.

### (re)build Jekyll bundles

When the image is created the Jekyll bundles are installed, so in general there shouldn't be much need to run this task. This is available however in case soemthing goes wrong or you are working on the Jekyll setup itself.

### (re)build node modules

Used to re-generate the node modules. Generally shouldn't be necessary unless something is broken or you are adding/changing versions of dependencies.

### ENiGMA½ new configuration

This task executes `oputil.js` in order to create a new BBS configuration (useful if you have just checked out the code and haven't setup any configuration yet.)

## Run / Debug config

There is also a default "Launch Program" config (hotkey access via F5 / Ctrl-Shift-D.) This will launch ENiGMA½. Once it has launched, access the system via telnet, port 8888 as usual.