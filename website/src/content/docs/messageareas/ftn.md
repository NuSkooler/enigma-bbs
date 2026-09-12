---
title: FidoNet-Style Networks (FTN)
description: "Configure FidoNet-style networks: your addresses, network definitions, and area mappings."
sidebar:
    order: 3
---

[FidoNet](https://en.wikipedia.org/wiki/FidoNet) proper and other FidoNet-Style networks are supported by ENiGMA½. A bit of configuration and you'll be up and running in no time!

:::note
Before proceeding you may wish to check [Setting up FTN-style message networks with ENiGMA½ BBS](https://medium.com/@alpha_11845/setting-up-ftn-style-message-networks-with-enigma%C2%BD-bbs-709b22a1ae0d) by Alpha. An excellent guide detailing some of the setup described here!
:::

## Configuration
Getting a fully running FTN enabled system requires a few configuration points:

1. `messageNetworks.ftn.networks`: Declares available networks. That is, networks you wish to sync up with.
2. `messageNetworks.ftn.areas`: Establishes local area mappings (ENiGMA½ to/from FTN area tags) and per-area specific configurations.
3. `scannerTossers.ftn_bso`: General configuration for the scanner/tosser (import/export) process. This is also where we configure per-node (uplink) settings.

:::note
ENiGMA½'s `ftn_bso` module is **not a mailer** and makes **no attempts** to perform packet transport! An external utility such as Binkd is required for this task.
:::

### Networks
The `networks` block is a per-network configuration where each entry's ID (or "key") may be referenced elsewhere in `config.hjson`. Network keys are matched case-insensitively, so `fsxNet`, `fsxnet`, and `FSXNET` are all equivalent — just be consistent within your config. For example, consider two networks: ArakNet and fsxNet:

```hjson
{
  messageNetworks: {
    ftn: {
      networks: {
        fsxnet: {
          defaultZone: 21
          localAddress: "21:1/121"
        }

        araknet: {
          defaultZone: 10
          localAddress: "10:101/9"
        }
      }
    }
  }
}
```

### Areas
The `areas` section describes a mapping of local **area tags** configured in your `messageConferences` (see [Configuring a Message Area](configuring-a-message-area.md)) to a message network (described above), a FTN specific area tag, and remote uplink address(s). This section can be thought of similar to the *AREAS.BBS* file used by other BBS packages.

When ENiGMA½ imports messages, they will be placed in the local area that matches key under `areas` while exported messages will be sent to the relevant `network`.

| Config Item | Required | Description                                              |
|-------------|----------|----------------------------------------------------------|
| `network`   | Yes     | Associated network from the `networks` section above |
| `tag`       | Yes     | FTN area tag (ie: `FSX_GEN`) |
| `uplinks`   | Yes     | An array of FTN address uplink(s) for this network |
| `relay`     | No      | Set `true` to pass imported EchoMail on to the area's other uplinks. See [Relaying EchoMail](#relaying-echomail-points-and-sub-hubs). |

### Relaying EchoMail (points and sub-hubs)

By default ENiGMA½ exports only the messages written by users on *this* system.
Mail that arrives from an area's upstream source is imported and stops there.

That is the right behaviour for an ordinary node, and the wrong one as soon as
something downstream of you is configured as a second uplink — a point, or a
sub-hub. Such a link would receive only local chatter and none of the echo it
actually subscribed to.

Set `relay: true` on an area to pass imported mail on:

```hjson
fsx_general: {
    network: fsxnet
    tag: FSX_GEN
    uplinks: [ "21:1/100", "21:1/121.1" ]    //  hub, and our own point
    relay: true
}
```

It is opt-in per area on purpose: relaying is visible to the rest of the
network, and a board that configured a second uplink for some other reason
should not silently start feeding it.

#### What gets relayed where

For each imported message, every uplink of the area is considered in turn:

- **Never back to the system that sent it.** The packet header origin recorded
  at import decides this, so it holds even when a sender omits itself from
  SEEN-BY.
- **Always to your own points.** SEEN-BY has no point component (FTS-1027): a
  point's net/node are its boss's, and an upstream sender routinely lists the
  boss before the message ever reaches you. A plain SEEN-BY test would therefore
  read "already seen" for every point, every time, and nothing would ever be
  relayed to one.
- **Otherwise, only if the uplink is not already in SEEN-BY**, which is the
  ordinary loop guard for a genuine peer relationship.

SEEN-BY and `^aPATH` are updated on the way out exactly as they are for locally
written mail, and the original `MSGID` is preserved rather than regenerated.

:::note[Where relaying starts]
The first time a relay-enabled area is scanned for a given uplink, ENiGMA½
records where the area currently is and exports nothing. Mail imported from that
point on is relayed; anything already in the message base is treated as history.

This matters on an established board, where the whole message base is imported
mail: without it, the first scan would offer years of traffic to a link that
never asked for it. It is also what makes adding an uplink to a busy area safe —
the new link starts from the present, not the beginning.
:::

:::note[Each uplink tracks its own progress]
Delivery is recorded per uplink, not per area. An uplink that cannot be reached
is retried with its own backlog and does not hold up — or re-send to — the ones
that are working.
:::

:::caution
Relaying to a genuine second *peer* — another hub rather than a point — is
supported by the SEEN-BY rule above, but it is far less exercised than the point
case. Watch your uplink's tosser log the first time round.
:::

Example:
```hjson
{
  messageNetworks: {
    ftn: {
      areas: {
        // it is recommended to use lowercase area tags
        fsx_general:        //  *local* tag found within messageConferences
          network: fsxnet   //  that we are mapping to this network
          tag: FSX_GEN      //  ...and this remote FTN-specific tag
          uplinks: [ "21:1/100" ] // a single string also allowed here
        }
      }
    }
  }
}
```

:::tip
You can import `AREAS.BBS` or FTN style `.NA` files using [oputil](../admin/oputil.md)!
:::

### A More Complete Example
Below is a more complete *example* illustrating some of the concepts above:

```hjson
{
  messageNetworks: {
    ftn: {
      networks: {
        fsxnet: {
          defaultZone: 21
          localAddress: "21:1/121"
        }
      }

      areas: {
        fsx_general: {
          network: fsxnet

          //  ie as found in your info packs .NA file
          tag: FSX_GEN

          uplinks: [ "21:1/100" ]
        }
      }
    }
  }
}
```

:::note
Remember for a complete FTN experience, you'll probably also want to configure [FTN/BSO scanner/tosser](bso-import-export.md) settings.
:::

### Automatic Area Creation
EchoMail that arrives for an FTN area tag you have not configured is skipped and, because the packet is then removed, lost. ENiGMA½ can instead create those areas for you. **The feature is off unless you configure it**, and a system with no `autoAreas` block behaves exactly as it always has.

#### Getting started
Run this once:

```bash
./oputil.js mb auto-areas init
```

That creates `config/auto-areas.hjson` and adds it to `includes` in your `config.hjson`, **in that order** — a file listed in `includes` that does not exist stops the board from starting, so it must be created first. The command is safe to re-run.

Automatically created areas are written to `auto-areas.hjson`, never to your `config.hjson`. Includes are merged such that **`config.hjson` always wins**, so that file can be rewritten on every pass without ever touching something you set by hand.

#### Configuration
Configured per network under `messageNetworks.ftn.networks.<network>.autoAreas`:

```hjson
{
  messageNetworks: {
    ftn: {
      networks: {
        fsxnet: {
          defaultZone: 21
          localAddress: "21:1/121"

          autoAreas: {
            //  conference new areas are placed in; must already exist
            confTag: fsxnet

            //  never create these, and remove them if already created
            ignore: [ "FSX_BOT", "SOME.AREA" ]

            //  cap on the TOTAL number ever created for this network
            maxAutoCreate: 500

            onDemand: {
              //  create areas when EchoMail arrives for an unknown tag
              enabled: true
            }

            infoPack: {
              //  take real names and descriptions from the network info pack
              enabled: true

              //  file area the pack is TIC'd into, and how to spot it there
              areaTag: fsxnet_info
              match: "fsxnet*.zip"

              //  the area list INSIDE the pack. Name it exactly: fsxNet also
              //  ships fsx_file.na, which is a FILEBONE file echo list
              areaFile: fsxnet.na
            }
          }
        }
      }
    }
  }
}
```

There is no parent `enabled` flag: the feature is on for a network if either `onDemand.enabled` or `infoPack.enabled` is set. Two flags that have to agree is a configuration bug waiting to happen.

| Config Item     | Required | Description |
|-----------------|----------|-------------|
| `confTag`       | Yes     | Message conference created areas are placed in. Must already exist; creation is refused otherwise |
| `ignore`        |          | FTN tags never to create. Also **removes** ones already created, so this is how you un-create something |
| `maxAutoCreate` |          | Cap on the total number of areas ever created for this network. Defaults to `500`. This is a total, not a per-run limit |

#### Created areas are read-only
An area created this way carries no `uplinks`, so nothing is ever exported from it. That alone is not read-only — a local user could still post into an area that looks live and goes nowhere — so it also gets `acs: { write: ID0 }`, which no user satisfies.

To adopt an area, define it in your `config.hjson` under the same conference and area tag with your own `uplinks` and `acs`. Your `config.hjson` wins over the generated file, so the two coexist.

Some tags are refused outright rather than merged, and the operator is told why:

* A tag that would lower case onto a built-in area, such as `PRIVATE_MAIL` → `private_mail`
* A tag already used by an area in **any** conference, or already carried by another network

#### The info pack
Networks distribute an "info pack" — an archive with the area list, nodelist and documentation — through a file echo, so it arrives by TIC like any other file. ENiGMA½ does not wait to be told about it; it looks in the file area you name. A pack that landed before you turned the feature on is picked up just the same, as is one you dropped in by hand and scanned with `oputil fb scan`.

Its job is narrow: replace the placeholder name and description on areas you **already carry**. A pack lists what the *network* carries, not what *you are linked to*, so creating from it wholesale would leave you with hundreds of permanently empty areas. Set `createUnlinked: true` if you want that anyway.

:::note
`areaFile` is an exact name for a reason. Most networks ship *two* `.na` files — one message echo list and one **file** echo list — and the extension does not tell them apart. Pointing at the wrong one gets you nothing; ENiGMA½ recognises a FILEBONE list and declines to take descriptions from it rather than importing nonsense.
:::

Some networks ship no machine-readable list at all. If the file cannot be recognised, you get a warning saying what it looked like instead, and your areas keep their tag-based names.

#### AreaFix rescan
Optionally, an AreaFix request can be sent to your uplink after an area is created, asking it to send the backlog. This is **off by default and has no default command**, because there is no portable syntax:

| Uplink software | Working per-area rescan |
|---|---|
| Mystic, CrashMail II | `=TAG R=n` |
| husky, SBBSecho | `%RESCAN TAG R=n` |

FSC-0057 specifies `=TAG R=n`, but husky and SBBSecho do not implement `=`: they read it as a request to *add* an area with a garbage tag, and a husky hub with `forwardRequests` may pass that upstream. So you state the form your uplink speaks, or nothing is sent:

```hjson
onDemand: {
  enabled: true
  rescan: true
  rescanUplink: "21:1/100"
  rescanPassword: "YOURPASS"
  rescanDays: 30

  //  %TAG% and %DAYS% are substituted
  rescanCommand: "=%TAG% R=%DAYS%"
}
```

Replies from the uplink's AreaFix robot are matched against requests actually sent — by address, robot name, and a 14 day window — and only lines naming an area asked about are read. You get a NetMail summarising what the uplink said. Reply wording differs between tossers; anything not recognised is reported with the raw line rather than acted on, and you can teach it more:

```hjson
messageNetworks: {
  ftn: {
    areaFixStatusPhrases: {
      "linked ok": added
    }
  }
}
```

#### Removing an area
Add its FTN tag to `ignore`. It is dropped from `auto-areas.hjson` on the next pass.

Its messages are **not** deleted — they stay in the database keyed by area tag, invisible, and reappear if the tag is ever created again. A later re-link and rescan will dupe-drop rather than re-import that history, since the MSGID duplicate check is system wide.

### FTN/BSO Scanner Tosser
Please see the [FTN/BSO Scanner/Tosser](bso-import-export.md) documentation for information on this area.