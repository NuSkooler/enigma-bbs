---
layout: page
title: Message Networks
---
Configuring message networks in ENiGMA½ requires three specific pieces of config - the network and your 
assigned address on it, the message areas (echos) of the network you wish to map to ENiGMA½ message areas, 
then the schedule and routes to send mail packets on the network.

## FTN Networks 
 
FTN networks are configured under the `messageNetworks::ftn` section of `config.hjson`.

The `networks` section contains a sub section for each network you wish you join your board to. 
Each entry's key name is referenced elsewhere in `config.hjson` for FTN oriented configurations.

### Example Configuration

```hjson
{
  messageNetworks: {
    ftn: {
      networks: {
        agoranet: { 
          localAddress: "46:3/102"
        }
        fsxnet: { 
          localAddress: "21:4/333"
        }
      }
    }
  }
}
```

## Message Areas

The `areas` section describes a mapping of local **area tags** configured in your `messageConferences` (see
[Configuring a Message Area](configuring-a-message-area.md)) to a message network (described 
above), a FTN specific area tag, and remote uplink address(s). 

This section can be thought of similar to the *AREAS.BBS* file used by other BBS packages. 

When ENiGMA½ imports messages, they will be placed in the local area that matches key under `areas`.

| Config Item | Required | Description                                              |
|-------------|----------|----------------------------------------------------------|
| `network`   | :+1:     | Associated network from the `networks` section above     |            
| `tag`       | :+1:     | FTN area tag                                             |
| `uplinks`   | :+1:     | An array of FTN address uplink(s) for this network       |

### Example Configuration

```hjson
{
  messageNetworks: {
    ftn: {
      areas: {
        agoranet_bbs: {          // tag found within messageConferences
          network: agoranet
          tag: AGN_BBS
          uplinks: "46:1/100"
        }
      }
    }
  }
}
```
