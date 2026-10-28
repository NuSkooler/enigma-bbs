---
title: Install Script
description: "Run install.sh to set up Node.js and ENiGMA½ in one step on Linux, BSD and macOS."
sidebar:
    order: 2
---
Under most Linux/UNIX like environments (Linux, BSD, OS X, ...)  new users can simply execute the `install.sh` script to get everything up and running. Cut + paste the following into your terminal:

```
curl -o- https://raw.githubusercontent.com/NuSkooler/enigma-bbs/master/misc/install.sh | bash
```

:::caution
You may wish to review the [installation script](https://raw.githubusercontent.com/NuSkooler/enigma-bbs/master/misc/install.sh) on GitHub before running it!
:::

The script will install `nvm`, Node.js and grab the latest ENiGMA BBS from GitHub. It will also guide you through creating a basic configuration file, and recommend some packages to install.

:::note
After installing:
* Read [External Binaries](../configuration/external-binaries.md)
* Read [Upgrading](../admin/upgrading.md)
* If you plan to run ENiGMA½ as a long-running service (systemd, etc.), read [Production Installation](production.md) — there are gotchas around `PATH` and version managers like `mise` that you'll want to know about up front.
:::

Once it finishes, [test your installation](testing.md).

## enig-term

When it installs ENiGMA½, the script asks:

```
Install the enig-term web terminal? [y/N]
```

[enig-term](../servers/loginservers/enig-term.md) is a browser terminal that ENiGMA½ serves at `/_enig/ws-term/`. The answer defaults to no. Answer `y` and the script downloads the latest enig-term release from GitHub, checks it against the release's `SHA256SUMS`, and unpacks it into `ws-term` in your install directory, which is all it takes to turn the route on. If the download fails, does not match its checksum, or `curl`/`wget`, `tar` or `sha256sum`/`shasum` is missing, it says so, installs nothing, and the rest of the installation carries on.

Answer ahead of time, or when there is no terminal to ask on, with environment variables:

| Variable | Effect |
|----------|--------|
| `ENIGMA_INSTALL_ENIG_TERM` | `yes` installs enig-term without asking, `no` skips it. With no terminal to ask on, the default is no. |
| `ENIGMA_ENIG_TERM_VERSION` | Installs that release, such as `0.1.0`, instead of the latest. |

```
curl -o- https://raw.githubusercontent.com/NuSkooler/enigma-bbs/master/misc/install.sh | ENIGMA_INSTALL_ENIG_TERM=yes bash
```

Afterwards, enig-term needs the [web server](../servers/contentservers/web-server.md) enabled and a secure WebSocket (`wss://`) that browsers can reach. Behind a TLS proxy, set the public endpoint in `config.hjson`:

```hjson
contentServers: {
    web: {
        wsTerm: {
            endpoint: "wss://bbs.example.com:44512"
        }
    }
}
```

Then browse to `https://bbs.example.com/_enig/ws-term/`. See [enig-term Web Terminal](../servers/loginservers/enig-term.md) for the rest of its settings.

You might also check out some external guides:
* https://www.maketecheasier.com/create-bbs-linux-with-enigmabbs/