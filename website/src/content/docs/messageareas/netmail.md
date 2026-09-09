---
layout: page
title: Netmail
---
ENiGMA supports import and export of Netmail from the Private Mail area. `RiPuk @ 21:1/136` and `RiPuk <21:1/136>` 'To' address formats are supported.

## Where NetMail Goes

A NetMail message reaches its destination one of two ways:

* **Direct** — the recipient is a node you have configured in `scannerTossers::ftn_bso::nodes`, and ENiGMA½ files the packet for that node. Nothing beyond the `nodes` entry is required.
* **Routed** — the recipient is handed to a *different* node for onward delivery, per a `netMail::routes` entry. This is how you reach anything outside the nodes you talk to directly.

Routes are consulted first, so a route always wins over a direct `nodes` match for the same address.

A destination that is neither routed nor a configured node is refused: the export is marked failed and the sender is sent a notice, rather than the message sitting in the spool unexplained.

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

Note that `routes` is consulted *before* `nodes`, so a catch-all `"*"` route claims **all** NetMail — including AreaFix messages addressed to your uplinks on other networks, which would otherwise go direct. Prefer a pattern per zone. Where you do want a catch-all, you can send specific addresses direct by pointing a more specific route at them:

````hjson
routes: {
    "21:1/100" : { address: "21:1/100", network: fsxnet }   //  direct
    "*"        : { address: "1:154/10", network: fidonet }  //  everything else
}
````

Each routed NetMail logs the address it was routed to at `debug` level, so the effective route can be confirmed from `logs/enigma-bbs.log`.

### Which Network It Is Sent As

The network decides two things: the address the message is sent **from**, and the outbound directory the packet is filed in. It is settled in this order:

1. The `network` named on the matching `routes` entry.
2. The `network` named on the matching `nodes` entry.
3. Otherwise, the network whose zone matches the node being dialed — mail to `1:154/10` goes out as your zone 1 identity, mail to `21:1/100` as your zone 21 one.

`network` is therefore optional in both places; the zone answers it for any ordinary setup. Name one only when two of your networks share a zone, which is the single case the zone cannot distinguish:

````hjson
nodes: {
    "1:154/10" : {
        network: fidonet   //  and not the other zone 1 network
    }
}
````

If no configured network claims the destination's zone, the message is refused rather than sent from an unrelated address.