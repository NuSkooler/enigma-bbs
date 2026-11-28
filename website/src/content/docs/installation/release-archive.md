---
title: Release Archive
description: "Download a released version of ENiGMA½ as an archive, verify it, and install it without git."
sidebar:
    order: 4
---
Every ENiGMA½ release is published on [GitHub](https://github.com/NuSkooler/enigma-bbs/releases) as an archive, `enigma-bbs-X.Y.Z.tar.gz` or `enigma-bbs-X.Y.Z.zip`. An archive holds what a board needs to run, without the tests, developer tooling or these docs, and without git history. Use it when you want a release but would rather not use git.

:::note
An archive install is upgraded side by side, by unpacking the next release in a new directory. See [Upgrading a Release Archive Install](../admin/upgrading.md#upgrading-a-release-archive-install). If you would rather upgrade in place, install a release with the [install script](install-script.md) or a [git checkout](manual.md#enigma-bbs) instead.
:::

## Prerequisites
The same as a [manual installation](manual.md#prerequisites): Node.js, Python, and a compiler for the native modules. Git is not needed.

## Download and Verify
From the release's page on GitHub, download the archive and `SHA256SUMS`. Then check the download:

```bash
sha256sum -c --ignore-missing SHA256SUMS
```

The archive should report `OK`. (`--ignore-missing` skips the archive you did not download. On macOS, use `shasum -a 256 -c --ignore-missing SHA256SUMS`.)

GitHub also holds signed build provenance for each archive, which shows it was built by the project's release workflow from the release's tag. With the [GitHub CLI](https://cli.github.com/) you can check it:

```bash
gh attestation verify enigma-bbs-0.7.0.tar.gz \
    --repo NuSkooler/enigma-bbs \
    --signer-workflow NuSkooler/enigma-bbs/.github/workflows/release.yml \
    --source-ref refs/tags/v0.7.0
```

Use the version you downloaded in place of `0.7.0`, and the `.zip` name if you downloaded that.

## Install
```bash
tar xzf enigma-bbs-0.7.0.tar.gz    # or: unzip enigma-bbs-0.7.0.zip
cd enigma-bbs-0.7.0
npm ci              # or: npm ci --omit=dev, to leave out the development tools
./oputil.js config new
```

`npm ci` installs exactly the packages the release was tested with. `./oputil.js config new` walks you through creating your configuration, as in a [manual installation](manual.md#config-files). Then read [External Binaries](../configuration/external-binaries.md), and [test your installation](testing.md).

Your configuration, databases, logs and files are kept inside this directory, so include it in your [backups](../admin/administration.md#backing-up-your-system).
