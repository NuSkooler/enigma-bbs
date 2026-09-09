---
title: About Servers
description: "Login servers are how users reach your board; content servers expose it to other protocols. What the difference means for your config."
sidebar:
    order: 0
---
ENiGMA½ runs two kinds of server, and the distinction matters because they are
configured in different blocks and do different jobs.

## Login Servers

A **login server** is a way for a person to *reach your board* — it carries a
terminal session, hands the user to a first menu, and from there they are on the
BBS. Configured under `loginServers` in `config.hjson`.

| Server | Default port | Notes |
|--------|--------------|-------|
| [Telnet](loginservers/telnet.md) | 8888 | Enabled by default. **Not secure** — credentials cross the wire in the clear |
| [SSH](loginservers/ssh.md) | 8889 | Encrypted, supports public key authentication. Needs a host key generated first |
| [WebSocket](loginservers/websocket.md) | 8810 / 8811 | Browser access, paired with a client such as VTX |

Features that require a secure connection — 2FA/OTP enrolment, uploading an SSH
public key — are available over SSH and secure WebSocket, and deliberately
blocked over plain Telnet.

:::tip
On \*nix, ports below 1024 are privileged. Most boards keep ENiGMA½ on the high
defaults and forward 23/22/443 to them, rather than running as root.
:::

## Content Servers

A **content server** exposes parts of the board *without* a terminal session —
message areas to a newsreader, files to a browser, your system to the Fediverse.
Configured under `contentServers`.

| Server | Default port | Exposes |
|--------|--------------|---------|
| [Web](contentservers/web-server.md) | 8080 / 8443 | Temporary file download links, password reset pages, static files, and the routes other handlers register |
| [Gopher](contentservers/gopher.md) | 8070 | Message conferences and areas, plus anything in your Gopher hole |
| [NNTP](contentservers/nntp.md) | 8119 / 8563 | Message conferences and areas to newsreaders |

Two further pieces build on the web server rather than standing alone: the
[REST API](contentservers/rest-api.md), and the
[web handlers](contentservers/web-handlers.md) that add routes — including
[WebFinger](contentservers/webfinger-handler.md) and
[ActivityPub](contentservers/activitypub-handler.md) for Fediverse federation.

## Which Do I Need?

At minimum, one login server, or nobody can call. Everything under content
servers is opt-in, and every one of them defaults to disabled.

The one that repays enabling early is the [web server](contentservers/web-server.md):
password reset links and [temporary file download URLs](../filebase/index.md#web-downloads)
both depend on it, and those are features users notice missing.
