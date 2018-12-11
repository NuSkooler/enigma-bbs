---
layout: page
title: Manual Installation
---
For Linux environments it's recommended you run the [install script](install-script.md). If you like to 
do things manually, read on...

## Prerequisites
* [Node.js](https://nodejs.org/) version **v10.x LTS or higher** (Note that 8.x LTS *probably* works but is unsupported).
  * :information_source: It is **highly** recommended to use [nvm](https://github.com/creationix/nvm) to manage your 
  Node.js installation if you're on a Linux/Unix environment.
  
* [Python](https://www.python.org/downloads/) 2.7.x for compiling Node.js packages with native extensions.

* A compiler such as Clang or GCC for Linux/UNIX systems or a recent copy of Visual Studio 
([Visual Studio Express](https://www.visualstudio.com/en-us/products/visual-studio-express-vs.aspx) editions 
are OK) for Windows users. Note that you **should only need the Visual C++ component**.

* [git](https://git-scm.com/downloads) to check out the ENiGMA source code.  
 
## Node.js
### With NVM
Node Version Manager (NVM) is an excellent way to install and manage Node.js versions on most UNIX-like environments. [Get the latest version here](https://github.com/creationix/nvm). The nvm install may look _something_ like this:

```bash
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.11/install.sh | bash
```
:information_source: Do not cut+paste the above command! Visit the [NVM](https://github.com/creationix/nvm) page and run the latest version!

Next, install Node.js with NVM:
```bash
nvm install 10
nvm use 10
nvm alias default 10
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
ENiGMA BBS makes use of a few packages for archive and legacy protocol support. They're not pre-requisites for running ENiGMA, but without them you'll miss certain functionality. Once installed, they should be made available on your system path.

| Package    | Description | Debian/Ubuntu Package (APT/DEP) | Red Hat Package (YUM/RPM) | Windows Package                                                  |
|------------|-----------------------------------|--------------------------------------------|---------------------------------------------------|------------------------------------------------------------------|
| arj        | Unpacking arj archives            | `arj`                                      | n/a, binaries [here](http://arj.sourceforge.net/) | [ARJ](http://arj.sourceforge.net/)                               |
| 7zip       | Unpacking zip, rar, archives  | `p7zip-full`                               | `p7zip-full`                                      | [7-zip](http://www.7-zip.org/)                                   |
| lha        | Unpacking lha archives  | `lhasa`                               | n/a, source [here](http://www2m.biglobe.ne.jp/~dolphin/lha/lha.htm)                                      | Unknown                                   |
| Rar        | Unpacking rar archives  | `unrar`                               | n/a, binaries [here](https://www.rarlab.com/download.htm)                                      | Unknown                                   |
| lrzsz      | sz/rz: X/Y/Z protocol support        | `lrzsz`                                    | `lrzsz`                                           | Unknown                                                          | 
| sexyz      | SexyZ protocol support               | [sexyz](https://l33t.codes/outgoing/sexyz) | [sexyz](https://l33t.codes/outgoing/sexyz)        | Available with [Synchronet](http://wiki.synchro.net/install:win) |
| exiftool   | [ExifTool](https://www.sno.phy.queensu.ca/~phil/exiftool/)    | libimage-exiftool-perl | perl-Image-ExifTool | Unknown
| xdms  | Unpack/view Amiga DMS | [xdms](http://manpages.ubuntu.com/manpages/trusty/man1/xdms.1.html)  | xdms | Unknown

## Config Files
You'll need a basic configuration to get started. The main system configuration is handled via `config/config.hjson`. This is an [HJSON](http://hjson.org/) file (compiliant JSON is also OK). See [Configuration](../configuration/) for more information.

Use `oputil.js` to generate your **initial** configuration: 

```bash
./oputil.js config new
```

Follow the prompts!
