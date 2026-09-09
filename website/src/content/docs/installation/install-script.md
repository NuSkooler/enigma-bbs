---
layout: page
title: Install Script
---
## Install Script
Under most Linux/UNIX like environments (Linux, BSD, OS X, ...)  new users can simply execute the `install.sh` script to get everything up and running. Cut + paste the following into your terminal:

```
curl -o- https://raw.githubusercontent.com/NuSkooler/enigma-bbs/master/misc/install.sh | bash
```

> :eyes: You may wish to review the [installation script](https://raw.githubusercontent.com/NuSkooler/enigma-bbs/master/misc/install.sh) on GitHub before running it!

The script will install `nvm`, Node.js and grab the latest ENiGMA BBS from GitHub. It will also guide you through creating a basic configuration file, and recommend some packages to install.

> :information_source: After installing:
> * Read [External Binaries](../configuration/external-binaries.md)
> * Read [Upgrading](../admin/upgrading.md)
> * If you plan to run ENiGMA½ as a long-running service (systemd, etc.), read [Production Installation](production.md) — there are gotchas around `PATH` and version managers like `mise` that you'll want to know about up front.

You might also check out some external guides:
* https://www.maketecheasier.com/create-bbs-linux-with-enigmabbs/