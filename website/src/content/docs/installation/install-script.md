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

The script will install [mise](https://mise.jdx.dev/), use it to install the Node.js version ENiGMA½ requires (read from its `package.json`), and grab the latest ENiGMA½ release from GitHub (see [Choosing a Version](#choosing-a-version)). It will also guide you through creating a basic configuration file, and recommend some packages to install.

:::note
After installing:
* Read [External Binaries](../configuration/external-binaries.md)
* Read [Upgrading](../admin/upgrading.md)
* If you plan to run ENiGMA½ as a long-running service (systemd, etc.), read [Production Installation](production.md) — there are gotchas around `PATH` and version managers like `mise` that you'll want to know about up front.
:::

Once it finishes, [test your installation](testing.md).

## Choosing a Version

By default the script installs the latest ENiGMA½ release. Set `ENIGMA_VERSION` to install something else:

| `ENIGMA_VERSION` | Installs |
|------------------|----------|
| `latest` (the default) | The latest release on GitHub. Pre-releases (`-rc` versions) are never the latest. |
| A version, such as `0.7.0` or `v0.7.0` | That release: the script checks out its tag, `v0.7.0`, and stops with an error if there is no such tag. |
| `master`, or another branch name | That branch, with every change merged since the last release. |

```
curl -o- https://raw.githubusercontent.com/NuSkooler/enigma-bbs/master/misc/install.sh | ENIGMA_VERSION=0.7.0 bash
```

The script itself always comes from `master`, as above; it can install any version.

:::note
Until the first release is published, `latest` finds none and the script installs `master`, saying so. It does the same if GitHub cannot be reached or refuses the request (GitHub limits how often a machine can ask without signing in), so the installation carries on either way. Set `ENIGMA_VERSION` if you need a particular version.
:::

`ENIGMA_BRANCH`, the setting before `ENIGMA_VERSION`, still works: `ENIGMA_BRANCH=master` installs `master`. If both are set, `ENIGMA_VERSION` is used.

`latest` is looked up on GitHub, in the repository `ENIGMA_SOURCE` names (by default `https://github.com/NuSkooler/enigma-bbs.git`), so a fork on GitHub gets its own latest release. For a source that is not on GitHub, `latest` installs `master`; set `ENIGMA_VERSION` to a version or branch instead.

A release is installed as a full git clone with its tag checked out, so git reports a "detached HEAD": that is expected. To move to a later release, see [Upgrading](../admin/upgrading.md), or run:

```bash
cd ~/enigma-bbs
git fetch --tags
git checkout v0.7.1
```

Running the script again over an existing install does the same: it fetches, then checks out the version asked for (and brings a branch such as `master` up to date). It stops with an error if local changes are in the way, or if the branch has commits of its own that are not upstream and upstream has moved on.

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