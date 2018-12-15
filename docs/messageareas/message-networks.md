---
layout: page
title: Message Networks
---
ENiGMA½ considers all non-ENiGMA½, non-local messages (and their networks, such as FTN "external". That is, messages are only imported and exported from/to such a networks. Configuring such external message networks in ENiGMA½ requires three sections in your `config.hjson`.

1. `messageNetworks.<networkType>.networks`: declares available networks.
2. `messageNetworks.<networkType>.areas`: establishes local area mappings and per-area specifics.
3. `scannerTossers.<name>`: general configuration for the scanner/tosser (import/export). This is also where we configure per-node settings.

## FTN Networks 
FidoNet and FidoNet style (FTN) networks as well as a [FTN/BSO scanner/tosser](bso-import-export.md) (`ftn_bso` module) are configured via the `messageNetworks.ftn` and `scannerTossers.ftn_bso` blocks in `config.hjson`.

:information_source: ENiGMA½'s `ftn_bso` module is not a mailer and **makes no attempts** to perfrom packet transport! An external utility such as Binkd is required for this!

### Networks
The `networks` block a per-network configuration where each entry's key may be referenced elswhere in `config.hjson`.

Example: the following example declares two networks: `agoranet` and `fsxnet`:
```hjson
{
  messageNetworks: {
    ftn: {
      networks: {
        araknet: {
          defaultZone: 10
          localAddress: "10:101/9"
        }
        fsxnet: {
          defaultZone: 21
          localAddress: "21:1/121"
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
| `network`   | :+1:     | Associated network from the `networks` section above |    
| `tag`       | :+1:     | FTN area tag (ie: `FSX_GEN`) |
| `uplinks`   | :+1:     | An array of FTN address uplink(s) for this network |

Example:
```hjson
{
  messageNetworks: {
    ftn: {
      areas: {
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
An example of the complete messageNetworks section for fsxNet:

 messageNetworks: {
	    ftn: {
	    	networks: {
		      fsxnet: {
              defaultXone: 21
			        localAddress: "21:1/121"
  		    }
	    	}
    		areas: {
		      FSX_BBS: {
    		  	network: fsxnet
		    	  tag: FSX_BBS
  			    uplinks: "21:1/100"
	  	    }
		      FSX_BOT: {
    	  		network: fsxnet
		      	tag: FSX_BOT
			      uplinks: "21:1/100"
  		    }
	  	    FSX_GEN: {
		  	    network: fsxnet
			      tag: FSX_GEN
  			    uplinks: "21:1/100"
	  	    }
		      FSX_CRY: {
			      network: fsxnet
    		  	tag: FSX_CRY
		    	  uplinks: "21:1/100"
  		    }
	  	    FSX_DAT: {
      			network: fsxnet
		      	tag: FSX_DAT
			      uplinks: "21:1/100"
		      }
  		    FSX_MAG: {
      			network: fsxnet
		      	tag: FSX_MAG
    	  		uplinks: "21:1/100"
		      }
  		    FSX_MYS: {
      			network: fsxnet
		      	tag: FSX_MYS
			      uplinks: "21:1/100"
		      }
     		}
     }
  }
  
Complete example of the local message area setup for fsxNet message bases:

	fsxnet: {
	    name: fsxNet
	    desc: "'F'un, 'S'imple, and e'X'perimental Network"
	    sort: 1
	    default: true
	    areas: {
		FSX_BBS: {
		    name: "BBS Software Development & Support"
		    desc: "BBS Software Development & Support"
		    sort: 1
		    default: true
		}
		FSX_BOT: {
		    name: "Automated roBOT Posts"
		    desc: "Automated roBOT Posts"
		    sort: 1
		    default: true
		}
		FSX_GEN: {
		    name: "Chat, Testing + More.."
		    desc: "Chat, Testing + More.."
		    sort: 1
		    default: true
		}
		FSX_CRY: {
		    name: "Cryptographics"
		    desc: "Cryptographics"
		    sort: 1
		    default: true
		}
		FSX_DAT: {
		    name: "Data Transfer Messages"
		    desc: "Data Transfer Messages"
		    sort: 1
		    default: true
		}
		FSX_MAG: {
		    name: "Magicka BBS Support/Dev"
		    desc: "Magicka BBS Support/Dev"
		    sort: 1
		    default: true
		}
		FSX_MYS: {
		    name: "Mystic BBS Support/Dev"
		    desc: "Mystic BBS Support/Dev"
		    sort: 1
		    default: true
		}
	    }
       }



### FTN/BSO Scanner Tosser
Please see the [FTN/BSO Scanner/Tosser](bso-import-export.md) documentation for information on this area.
