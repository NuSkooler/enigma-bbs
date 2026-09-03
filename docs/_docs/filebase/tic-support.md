---
layout: page
title: TIC Support
---
## TIC Support
ENiGMA½ supports FidoNet-Style TIC file attachments by mapping external TIC area tags to local file areas.

Files can be **received** from an uplink and, if you declare downlinks, **passed on** to them — see [Forwarding to Downlinks](#forwarding-to-downlinks).

Under a given node defined in the `ftn_bso` config section in `config.hjson` (see
[BSO Import/Export](../messageareas/bso-import-export.md)), TIC configuration may be supplied:

```hjson
{
  scannerTossers: {
    ftn_bso: {
      nodes: {
        "46:*": {
          packetPassword: mypass
          encoding: cp437
          archiveType: zip
          tic: { // <--- General TIC config for 46:*
            password: TESTY-TEST  // see tip below for keeping this out of plain text
            uploadBy: AgoraNet TIC
            allowReplace: true
          }
        }
      }
    }
  }
}
```

> :bulb: Avoid storing `password` in plain text. Use `@file:` or `@environment:` instead:
> ```hjson
> password: "@file:/run/secrets/tic_pass"
> ```
> See [Configuration Files — Secret Files](../configuration/config-files.md#secret-files) for details.

Valid `tic` members:

| Item | Required | Description |
|--------|---------------|------------------|
| `password` | :-1: | TIC packet password, if required. Compared without regard to case, as other FTN software does |
| `uploadBy` | :-1: | Sets the "uploaded by" field for TIC attachments, for example "AgoraNet TIC" |
| `allowReplace` | :-1: | Set to `true` to allow TIC attachments to replace each other. This is especially handy for things like weekly node list attachments |
| `descPriority` | :-1: | Where the file description comes from: `diz` (default) prefers a `FILE_ID.DIZ` shipped inside the file, `tic` prefers the TIC's own `Ldesc` |
| `exportType` | :-1: | Flavour of the outbound queued for this downlink: `crash` (default), `hold`, `direct` or `normal`. HTick calls this `fileEchoFlavour` |
| `noTic` | :-1: | Send the file with **no** companion TIC. HTick's `noTIC` |
| `longNames` | :-1: | Emit `Lfile` (long file names). Defaults to `true` |
| `passUnknownKeywords` | :-1: | Pass keywords we do not recognise through unchanged. Defaults to `true`; set `false` for a peer in FSC-87 subset mode |
| `sha256` | :-1: | Pass a `Sha256` line through. Defaults to `false` |
| `addressDimensions` | :-1: | Dimensions to write `From` and `To` in — `3D`, `4D` (default) or `5D`. **`Seenby` is always written 4D** regardless: it is the loop guard, and some processors match it by exact string, so a `@domain` there can cause a downlink to send a file back to a system that already has it |
| `fileCase` | :-1: | Case of generated `.tic` filenames — `lower` (default) or `upper` |
| `allowUnverifiedForward` | :-1: | Forward files received from this node even though it has no `password`, i.e. was never authenticated. Defaults to `false` |

The `password`, `uploadBy`, `allowReplace` and `descPriority` members may also be
set once for all nodes under `scannerTossers.ftn_bso.tic`, where the following
system-wide members live as well:

| Item | Required | Description |
|--------|---------------|------------------|
| `secureInOnly` | :-1: | Only process TIC files found in the **secure** inbound (`paths.secInbound`). Defaults to `true`. TIC files in the unsecure inbound are left where they are, not imported and not deleted |
| `requireAreaAuthorization` | :-1: | Also require the sender to be an `uplinks` entry of the area when **importing**, not only when forwarding. Defaults to `false`. See [Restricting who may import](#restricting-who-may-import) |
| `holdMaxAgeMs` | :-1: | How long to keep a TIC whose file has not arrived yet. Defaults to 48 hours; set to `0` to hold indefinitely. See [Files arriving after their TIC](#files-arriving-after-their-tic) |

### Files arriving after their TIC
A `.tic` and the file it announces frequently arrive in **separate mailer
sessions**, sometimes many minutes apart. ENiGMA½ handles this the way other FTN
file processors do: a TIC whose file is not present yet — or is still being
written into the inbound — is **held** and retried on later import passes rather
than rejected. Nothing is deleted while a TIC is being held.

A held TIC is retried on every import cycle, including the one triggered
immediately when a BinkP session delivers files, so the file is normally picked
up within seconds of arriving. If it never arrives, the TIC is given up on after
`holdMaxAgeMs` and archived to `paths.reject` as before.

The announced name is matched **case-insensitively** against the inbound, so a
TIC naming `NODELIST.Z34` still finds a `nodelist.z34` on disk.

Next, we need to configure the mapping between TIC areas you want to carry, and the file base area (and, optionally, specific storage tag) for them to be tossed to. You can also add hashtags to the tossed files to assist users in searching for files:

```hjson
ticAreas: {
    agn_node: {
        areaTag: msgNetworks
        storageTag: msg_network
        hashTags: agoranet,nodelist
    }
}

```

> :information_source: Note that in the example above `agn_node` represents the **external** network area tag, usually represented in all caps. In this case, `AGN_NODE`.

Valid `ticAreas` members under a given node mapping are as follows:

| Item | Required | Description |
|--------|---------------|------------------|
| `areaTag` | :+1: | Specifies the local areaTag in which to place TIC attachments |
| `storageTag` | :-1: | Optionally, set a specific storageTag. If not set, the default for this area will be used. |
| `hashTags` | :-1: | One or more optional hash tags to assign TIC attachments in this area. |
| `downlinks` | :-1: | Addresses to forward this area's files on to. See [Forwarding to Downlinks](#forwarding-to-downlinks) |
| `uplinks` | :-1: | Addresses permitted to **publish** into this area. **Required if `downlinks` is set** — an area with downlinks and no uplinks forwards nothing |
| `network` | :-1: | Which network in `messageNetworks.ftn.networks` this area belongs to. Only needed when forwarding, and only strictly required if the downlinks' zone is claimed by more than one of your networks |


💡 Multiple TIC areas can be mapped to a single file base area.

### Example Configuration
Example configuration fragments mapping file base areas, FTN BSO node configuration and TIC area configuration.

```hjson
fileBase: {
    areaStoragePrefix: /home/bbs/file_areas/

    storageTags: {
        msg_network: "msg_network"
    }

    areas: {
        msgNetworks: {
            name: Message Networks
            desc: Message networks news & info
            storageTags: [
                "msg_network"
            ]
        }
    }
}

scannerTossers: {
    ftn_bso: {
        nodes: {
            "46:*": {
                packetPassword: mypass
                encoding: cp437
                archiveType: zip
                tic: {
                    password: TESTY-TEST
                    uploadBy: Agoranet TIC
                    allowReplace: true
                }
            }
        }

        ticAreas: {
            // here we map AgoraNet AGN_NODE -> local msgNetworks file area
            agn_node: {
                areaTag: msgNetworks
                storageTag: msg_network
                hashTags: agoranet,nodelist
            }
            agn_info: {
                areaTag: msgNetworks
                storageTag: msg_network
                hashTags: agoranet,infopack
            }
        }
    }
}


```

### Restricting who may import
By default, **any** node in `nodes` may announce a file into **any** area you carry. Authentication is not per-area: `From` is checked against your node list and the `Area` is checked against the areas you carry, but nothing correlates the two.

Setting `tic.requireAreaAuthorization` to `true` requires the sender to be listed in that area's `uplinks` before the file is imported — the same check that already governs forwarding.

```hjson
tic: {
    requireAreaAuthorization: true
}
```

> :warning: This needs an `uplinks` list on **every** area you import, and it fails closed: an area naming no uplinks refuses everything. It also requires a `ticAreas` entry per area, since an area matched only by its file base tag has nowhere to put `uplinks`.
>
> While the setting is off, startup logs exactly which areas would stop importing if you turned it on — so you can see the cost before paying it. Look for *"If … requireAreaAuthorization were enabled, these areas would stop importing"*.

It is off by default only for compatibility; nothing in an existing configuration says who is entitled to which echo. A forwarding hub already has the `uplinks` lists this needs, so for one it usually costs nothing to enable.

## Forwarding to Downlinks
By default ENiGMA½ is a **leaf node**: files arrive from an uplink, are imported, and go no further. Add `downlinks` to a `ticAreas` entry and it will also pass them on, generating a TIC for each downlink.

```hjson
ticAreas: {
    fsx_gen: {
        areaTag: fsxGeneral
        storageTag: fsx_gen

        //  which of your networks signs the outgoing Path and Seenby
        network: fsxnet

        //  who may publish into this echo — required when forwarding
        uplinks: [ "21:1/100" ]

        downlinks: [ "21:1/200", "21:2/150" ]
    }
}
```

> :warning: `uplinks` is what stops a node you have configured for some *other*
> reason from announcing a file into this echo and having you relay it to its
> subscribers under your own address. Every node in `nodes` is otherwise equally
> able to send you a TIC for any area you carry — authentication is not
> per-area. Name the system that actually feeds you this echo.
>
> An area with `downlinks` and no `uplinks` **forwards nothing**, and says so at
> startup. That is deliberate: relaying on behalf of an unspecified set of
> senders is the outcome this prevents.

Each downlink also needs an entry in `nodes` — that is where its TIC password and any per-link options live:

```hjson
nodes: {
    "21:1/200": {
        tic: {
            password: THEIRPASS  // written as "Pw" in the TIC we send them
        }
    }
}
```

> :information_source: `downlinks` belongs to the **external** area tag, not to the local file base area. A file echo is the thing with subscribers, and one local area may carry several echoes.

### What gets sent
For each downlink that should receive the file, ENiGMA½ queues **the file itself followed by a generated `.tic`**, in that order — [FSC-0087](http://ftsc.org/docs/fsc-0087.001) requires the file to be sent first so a failed session cannot orphan a TIC. The file is sent from your file base and left there; the generated TIC is deleted once sent.

The outgoing TIC carries your address in `From` and a new `Path` line, the downlink in `To`, that downlink's `password` in `Pw`, and the full `Seenby` list. Keywords ENiGMA½ does not recognise are passed through unchanged, as both [FTS-5006](http://ftsc.org/docs/fts-5006.001) and FSC-0087 require.

### Who gets skipped
A configured downlink is **not** sent the file when it is already listed in the TIC's `Seenby` (this is the loop guard), is the node that sent you the file, is the TIC's `To`, is the file's `Origin`, or is one of your own addresses. Skips are logged at `debug`.

### Who may publish
Only an address listed in that area's `uplinks` may cause a file to be forwarded. A sender is matched allowing for the address-dimension differences that are normal in FTN control data, so an uplink written `21:1/100` still matches a TIC saying `21:1/100@fsxnet`. An entry containing `*` is treated as a wildcard pattern, as in `nodes` — convenient, but naming a concrete address is the point of the list.

This is a **forwarding** control. Importing a TIC into your own file base is unchanged and is not area-scoped; see [Forwarding to Downlinks](#forwarding-to-downlinks) above for why the two differ.

### When nothing is forwarded at all
Forwarding is gated more tightly than importing, because importing affects only your own file base while forwarding makes other systems receive traffic your `Path` and `Seenby` lines vouch for. Nothing is forwarded when:

* The TIC arrived in the **unsecure** inbound. This holds even if you set `tic.secureInOnly` to `false` to import from there.
* The sending node has **no `tic.password`** configured, so it was never actually authenticated. Set one, or set `allowUnverifiedForward` on that node.
* The TIC's `To` names a system that is not you — the file is in transit through you. It is still imported, but re-announcing it under your name would be wrong. Routing such files onward is not implemented.
* The file collided with one you already hold and was stored under a different name. Announcing one name while sending another leaves the downlink with a file it cannot pair up.
* The sender is not listed in the area's `uplinks`, or the area names no `uplinks` at all.

Each of these is logged at `warn` with the reason.

### Replaced files
When a TIC's `Replaces` supersedes a file you have already queued for a downlink that has not yet collected it, the old file **and** its TIC are removed from that downlink's outbound. Anything already sent is left alone. Without this a downlink that polls infrequently would receive both, and the older one would in any case have been deleted locally by then.

### Checking your configuration
Problems that would otherwise be silent are reported at startup — an area with `downlinks` but no `uplinks` (which forwards nothing), an area with no resolvable `network`, a downlink missing from `nodes`, a downlink with no `tic.password` (its TICs will carry no `Pw` line), or an area whose zone more than one of your networks claims. If an area imports fine but never forwards, look there first.

## See Also
[Message Networks](../messageareas/message-networks.md)
