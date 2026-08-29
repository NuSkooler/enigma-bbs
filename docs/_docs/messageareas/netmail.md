---
layout: page
title: Netmail
---
ENiGMA supports import and export of Netmail from the Private Mail area. `RiPuk @ 21:1/136` and `RiPuk <21:1/136>` 'To' address formats are supported.

## Netmail Routing

A configuration block must be added to the `scannerTossers::ftn_bso` section in `config.hjson` to tell the ENiGMA½ tosser where to route NetMail.

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

### Routing Out Of Zone

The route address does not have to be in the same zone as the recipient — routing zone 2 mail out through a zone 1 uplink is the standard FidoNet zone gate:

````hjson
scannerTossers: {
    ftn_bso: {
        netMail: {
            routes: {
                "2:*" : {
                    address: "1:154/10"
                    network: fidonet
                }
            }
        }
    }
}
````

The packet is filed in the outbound directory belonging to the **route** address, since that is the node the mailer will call.

### Which Route Applies

Route keys are address patterns, and more than one can match a given recipient. The **most specific match wins**, regardless of the order entries appear in `config.hjson` — `"21:1/100"` beats `"21:*"`, which in turn beats `"*"`.

Note that `routes` is consulted *before* `nodes`, so a catch-all `"*"` route claims **all** NetMail — including AreaFix messages addressed to your uplinks on other networks. Prefer a pattern per zone. Where you do want a catch-all, you can send specific addresses direct by pointing a more specific route at them:

````hjson
routes: {
    "21:1/100" : { address: "21:1/100", network: fsxnet }   //  direct
    "*"        : { address: "1:154/10", network: fidonet }  //  everything else
}
````

Each routed NetMail logs the address it was routed to at `debug` level, so the effective route can be confirmed from `logs/enigma-bbs.log`.