---
layout: page
title: Manual Installation
---
For Linux environments it's recommended you run the [install script](install-script.md). If you like to
do things manually, read on...

## Prerequisites
* [Node.js](https://nodejs.org/) version **v14.x LTS or higher**. Versions under v14 are known not to work due to language level changes.
  * :bulb: It is **highly** recommended to use [Node Version Manager (NVM)](https://github.com/creationix/nvm) to manage your Node.js installation if you're on a Linux/Unix environment.

* [Python](https://www.python.org/downloads/) for compiling Node.js packages with native extensions via `node-gyp`.

* A compiler such as Clang or GCC for Linux/UNIX systems or a recent copy of Visual Studio
([Visual Studio Express](https://www.visualstudio.com/en-us/products/visual-studio-express-vs.aspx) editions
are OK) for Windows users. Note that you **should only need the Visual C++ component**.

* [Git](https://git-scm.com/downloads) to check out the ENiGMA source code.

## Node.js
### With NVM
Node Version Manager (NVM) is an excellent way to install and manage Node.js versions on most UNIX-like environments. [Get the latest version here](https://github.com/creationix/nvm). The nvm install may look _something_ like this:

```bash
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.11/install.sh | bash
```
:information_source: Do not cut+paste the above command! Visit the [NVM](https://github.com/creationix/nvm) page and run the latest version!

Next, install Node.js with NVM:
```bash
nvm install 12
nvm use 12
nvm alias default 12
```

If the above steps completed without errors, you should now have `nvm`, `node`, and `npm` installed and in your environment.

For Windows nvm-like systems exist ([nvm-windows](https://github.com/coreybutler/nvm-windows), ...) or [just download the installer](https://nodejs.org/en/download/).


## ENiGMA BBS
```bash
git clone https://github.com/NuSkooler/enigma-bbs.git
```

## Install Node Packages
```bash
cd enigma-bbs
npm install # yarn also works
```

## Other Recommended Packages
ENiGMA BBS makes use of a few packages for archive and legacy protocol support. They're not pre-requisites for running ENiGMA, but without them you'll miss certain functionality. Once installed, they should be made available on your systems `PATH`.

:information_source: Please see [External Binaries](../configuration/external-binaries.md) for information on setting these up.

:information_source: Additional information in [Archivers](../configuration/archivers.md) and [File Transfer Protocols](../configuration/file-transfer-protocols.md)

## Config Files
You'll need a basic configuration to get started. The main system configuration is handled via `config/config.hjson`. This is an [HJSON](http://hjson.org/) file (compliant JSON is also OK). See [Configuration](../configuration/hjson.md) for more information.

Use `oputil.js` to generate your **initial** configuration:

```bash
./oputil.js config new
```

Follow the prompts!
