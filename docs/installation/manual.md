---
layout: page
title: Manual Installation
---
For Linux environments it's recommended you run the [install script](install-script.md). If you like to 
do things manually, read on...

## Prerequisites
* [Node.js](https://nodejs.org/) version **v6.x or higher**
  * :information_source: It is **highly** recommended to use [nvm](https://github.com/creationix/nvm) to manage your 
  Node.js installation if you're on a Linux/Unix environment.
  
* [Python](https://www.python.org/downloads/) 2.7.x for compiling Node.js packages with native extensions.

* A compiler such as Clang or GCC for Linux/UNIX systems or a recent copy of Visual Studio 
([Visual Studio Express](https://www.visualstudio.com/en-us/products/visual-studio-express-vs.aspx) editions 
are OK) for Windows users. Note that you **should only need the Visual C++ component**.

* [git](https://git-scm.com/downloads) to check out the ENiGMA source code.  
 
## Node.js
If you're new to Node.js and/or do not care about Node itself and just want to get ENiGMA½ running 
these steps should get you going on most \*nix type environments:

```bash
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.0/install.sh | bash
nvm install 6
nvm use 6
```

If the above completed without errors, you should now have `nvm`, `node`, and `npm` installed and in your environment.

For Windows nvm-like systems exist ([nvm-windows](https://github.com/coreybutler/nvm-windows), ...) or [just download the installer](https://nodejs.org/en/download/).

  
## ENiGMA BBS
```bash
git clone https://github.com/NuSkooler/enigma-bbs.git
```

## Install Node Packages
```bash
cd enigma-bbs
npm install
```

## Other Recommended Packages

ENiGMA BBS makes use of a few packages for unarchiving and modem support. They're not pre-requisites for
running ENiGMA, but without them you'll miss certain functionality. Once installed, they should be made 
available on your system path.

| Package    | Description                       | Ubuntu Package                             | CentOS Package Name                               | Windows Package                                                  |
|------------|-----------------------------------|--------------------------------------------|---------------------------------------------------|------------------------------------------------------------------|
| arj        | Unpacking arj archives            | `arj`                                      | n/a, binaries [here](http://arj.sourceforge.net/) | [ARJ](http://arj.sourceforge.net/)                               |
| 7zip       | Unpacking zip, rar, archives  | `p7zip-full`                               | `p7zip-full`                                      | [7-zip](http://www.7-zip.org/)                                   |
| lha        | Unpacking lha archives  | `lhasa`                               | n/a, source [here](http://www2m.biglobe.ne.jp/~dolphin/lha/lha.htm)                                      | Unknown                                   |
| Rar        | Unpacking rar archives  | `unrar`                               | n/a, binaries [here](https://www.rarlab.com/download.htm)                                      | Unknown                                   |
| lrzsz      | sz/rz: X/Y/Z modem support        | `lrzsz`                                    | `lrzsz`                                           | Unknown                                                          | 
| sexyz      | SexyZ modem support               | [sexyz](https://l33t.codes/outgoing/sexyz) | [sexyz](https://l33t.codes/outgoing/sexyz)        | Available with [Synchronet](http://wiki.synchro.net/install:win) |

      - exiftool & other external tools

## Config Files

You'll need a basic configuration to get started. The main system configuration is handled via 
`config/config.hjson`. This is an [HJSON](http://hjson.org/) file (compiliant JSON is also OK). 
See [Configuration](../configuration/) for more information.

Use `oputil.js` to generate your **initial** configuration: 

```bash
./oputil.js config new
```

Follow the prompts!
