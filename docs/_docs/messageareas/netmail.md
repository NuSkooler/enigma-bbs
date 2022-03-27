---
layout: page
title: Netmail
---
ENiGMA support import and export of Netmail from the Private Mail area. `RiPuk @ 21:1/136` and `RiPuk <21:1/136>` 'To' address formats are supported.

## Netmail Routing

A configuration block must be added to the `scannerTossers::ftn_bso` `config.hjson` section to tell the ENiGMA½ tosser where to route NetMail.

The following configuration would tell ENiGMA½ to route all netmail addressed to 21:* through 21:1/100, and all 46:* netmail through 46:1/100:

````hjson 

scannerTossers: {
    
    /* other scannerTosser config removed for clarity */
    
    ftn_bso: {
        netMail: {
            routes: {
                "21:*" : {
                    address: "21:1/100"
                    network: fsxnet
                }
                "46:*" : {
                    address: "46:1/100"
                    network: agoranet
                }
            }
        }
    }
}
````
The `network` tag must match the networks defined in `messageNetworks::ftn::networks` within `config.hjson`.