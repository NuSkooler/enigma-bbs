---
layout: page
title: config.hjson
---
## System Configuration
The main system configuration file, `config.hjson` both overrides defaults and provides additional configuration such as message areas. The default path is `/enigma-bbs-install-path/config/config.hjson` though you can override the `config.hjson` location with the `--config` parameter when invoking `main.js`. Values found in `core/config.js` may be overridden by simply providing the object members you wish replace.

### Creating a Configuration
Your initial configuration skeleton can be created using the `oputil.js` command line utility. From your enigma-bbs root directory:
```
./oputil.js config new
```

You will be asked a series of questions to create an initial configuration.

### Overriding Defaults
The file `core/config.js` provides various defaults to the system that you can override via `config.hjson`. For example, the default system name is defined as follows:
```javascript
general : {
  boardName : 'Another Fine ENiGMA½ System'
}
```

To override this for your own board, in `config.hjson`:
```hjson
general: {
  boardName: Super Fancy BBS
}
```

(Note the very slightly different syntax. **You can use standard JSON if you wish**)

While not everything that is available in your `config.hjson` file can be found defaulted in `core/config.js`, a lot is. [Poke around and see what you can find](https://github.com/NuSkooler/enigma-bbs/blob/master/core/config.js)!


### A Sample Configuration
Below is a **sample** `config.hjson` illustrating various (but certainly not all!) elements that can be configured / tweaked.

**This is for illustration purposes! Do not cut & paste this configuration!**


```hjson
{
	general: {
		boardName: A Sample BBS
		menuFile: "your_bbs.hjson" // copy of menu.hjson file (and adapt to your needs)
	}

	defaults: {
		theme: "super-fancy-theme" // default-assigned theme (for new users) 
	}

	preLoginTheme: "luciano_blocktronics" // theme used before a user logs in (matrix, NUA, etc.)

	messageConferences: {
		local_general: {
			name: Local
			desc: Local Discussions
			default: true

			areas: {
				local_enigma_dev: {
					name: ENiGMA 1/2 Development
					desc: Discussion related to development and features of ENiGMA 1/2!
					default: true
				}
			}
		}

		agoranet: {
			name: Agoranet
			desc: This network is for blatant exploitation of the greatest BBS scene art group ever.. ACiD.

			areas: {
				agoranet_bbs: {
					name: BBS Discussion
					desc: Discussion related to BBSs
				}
			}
		}
	}

	messageNetworks: {
		ftn: {
			areas: {
				agoranet_bbs: { /* hey kids, this matches above! */

					// oh oh oh, and this one pairs up with a network below
					network: agoranet
					tag: AGN_BBS
					uplinks: "46:1/100"
				}
			}

			networks: {
				agoranet: {
					localAddress: "46:3/102"
				}
			}
		}
	}

	scannerTossers: {
		ftn_bso: {
			schedule: {
				import: every 1 hours or @watch:/home/enigma/bink/watchfile.txt
				export: every 1 hours or @immediate
			}

			defaultZone: 46
			defaultNetwork: agoranet

			nodes: {
				"46:*": {
					archiveType: ZIP
					encoding: utf8
				}
			}
		}
	}
}
```
