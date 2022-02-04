---
layout: page
title: TIC Support
---
## TIC Support
ENiGMA½ supports FidoNet-Style TIC file attachments by mapping TIC areas to local file areas.

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
          tic: {
            password: TESTY-TEST
            uploadBy: Agoranet TIC
            allowReplace: true
          }
        }
      }
    }
  }
}
```

You then need to configure the mapping between TIC areas you want to carry, and the file base area and storage tag for them to be tossed to. Optionally you can also add hashtags to the tossed files to assist users in searching for files:

```hjson
ticAreas: {
    agn_node: {
        areaTag: msgNetworks
        storageTag: msg_network
        hashTags: agoranet,nodelist
    }
}

```
Multiple TIC areas can be mapped to a single file base area.

### Example Configuration
An example configuration linking file base areas, FTN BSO node configuration and TIC area configuration.

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
    }
}


ticAreas: {
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
```

## See Also
[Message Networks](../messageareas/message-networks.md)
