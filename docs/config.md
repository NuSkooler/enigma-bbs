# Configuration
Configuration files in ENiGMA½ are simple UTF-8 encoded [HJSON](http://hjson.org/) files. HJSON is just like JSON but simplified and much more resilient to human error.

## System Configuraiton
The main system configuration file, `config.hjson` both overrides defaults and provides additional configuration such as message areas. The default path is `~/.config/enigma-bbs/config.hjson` though you can override this with the `--config` parameter when invoking `main.js`. Values found in core/config.js may be overridden by simply providing the object members you wish replace.

**Windows note**: **~** resolves to *C:\Users\YOURLOGINNAME\* on modern installations, e.g. *C:\Users\NuSkooler\\.config\enigma-bbs\config.hjson*

### oputil.js
Please see `oputil.js config` for configuration generation options.

### Example: System Name
`core/config.js` provides the default system name as follows:
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

### Specific Areas of Interest
* [Doors](doors.md)
* [MCI Codes](mci.md)
* [Menu System](menu_system.md)
* [Message Conferences](msg_conf_area.md)
* [Message Networks](msg_networks.md)
* [File Archives & Archivers](archives.md)


### A Sample Configuration
Below is a **sample** `config.hjson` illustrating various (but certainly not all!) elements that can be configured / tweaked.

**This is for illustration purposes! Do not cut & paste this configuration!**


```hjson
{
	general: {
		boardName: A Sample BBS
	}

	defaults: {
		theme: super-fancy-theme
	}

	preLoginTheme: luciano_blocktronics

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

## Menus
TODO: Documentation on menu.hjson, etc.