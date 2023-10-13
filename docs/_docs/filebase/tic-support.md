---
layout: page
title: TIC Support
---
## TIC Support
ENiGMA½ supports FidoNet-Style TIC file attachments by mapping external TIC area tags to local file areas.

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
            password: TESTY-TEST
            uploadBy: AgoraNet TIC
            allowReplace: true
          }
        }
      }
    }
  }
}
```

Valid `tic` members:

| Item | Required | Description |
|--------|---------------|------------------|
| `password` | :-1: | TIC packet password, if required |
| `uploadedBy` | :-1: | Sets the "uploaded by" field for TIC attachments, for example "AgoraNet TIC" |
| `allowReplace` | :-1: | Set to `true` to allow TIC attachments to replace each other. This is especially handy for things like weekly node list attachments |

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

## See Also
[Message Networks](../messageareas/message-networks.md)
