---
layout: page
title: Telnet Bridge
---
## Telnet Bridge
The `telnet_bridge` module allows "bridged" Telnet connections from your board to other Telnet services (such as other BBSes!).

## Configuration
### Config Block
Available `config` entries:
* `host`: Hostname or IP address to connect to.
* `port`: Port to connect to. Defaults to the standard Telnet port of `23`.
* `font`: A SyncTERM style font. Useful for example if you would like to connect form a "DOS" style BBS to an Amiga. See [the general art documentation on SyncTERM Style Fonts](../art/general.md).

### Example
Below is an example `menu.hjson` entry that would connect to [Xibalba](https://xibalba.l33t.codes):

```hjson
{
    telnetBridgeXibalba: {
        desc: Xibalba BBS
        module: telnet_bridge
        config: {
            host: xibalba.l33t.codes
            port: 45510
        }
    }
}
```

### Using Extra Args
The `telnet_bridge` module can also accept standard `extraArgs` of the same configuration arguments described above. This can be illustrated with an example:

```hjson
telnetBridgeMenu: {
    desc: Telnet Bridge
    art: telnet_bridge
    config: {
        font: cp437
    }
    form: {
        0: {
            mci: {
                VM1: {
                    argName: selection

                    items: [
                        {
                            board: BLACK Flag
                            soft: Mystic
                            data: bf
                        }
                        {
                            board: Xibalba
                            soft: ENiGMA½
                            data: xib
                        }
                    ]

                    //  sort by 'board' fields above
                    sort: board
                    submit: true
                }
            }

            submit: {
                *: [
                    {
                        value: { "selection" : "bf" }
                        action: @menu:telnetBridgeFromExtraFlags
                        extraArgs: {
                            host: blackflag.acid.org
                        }
                    }
                    {
                        value: { "selection" : "xib" }
                        action: @menu:telnetBridgeFromExtraFlags
                        extraArgs: {
                            host: xibalba.l33t.codes
                            port: 44510
                        }
                    }
                ]
            }
        }
    }
}

telnetBridgeFromExtraFlags: {
    desc: Telnet Bridge
    module: telnet_bridge
}
```

Here we've created a lightbar menu with custom items in which we'd use `itemFormat`'s with in a theme. When the user selects an item, the `telnetBridgeFromExtraFlags` menu is instantiated using the supplied `extraArgs`.

