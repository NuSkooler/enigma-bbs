---
layout: page
title: System Configuration
---
## System Configuration
The main system configuration file, `config.hjson` both overrides defaults and provides additional configuration such as message areas. The default path is `/enigma-bbs-install-path/config/config.hjson` though you can override the `config.hjson` location with the `--config` parameter when invoking `main.js`. Values found in `core/config.js` may be overridden by simply providing the object members you wish replace.

See also [HJSON General Information](hjson.md) for more information on the HJSON format.

### Creating a Configuration
Your initial configuration skeleton should be created using the `oputil.js` command line utility. From your enigma-bbs root directory:
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

(Note the very slightly [HJSON](hjson.md) different syntax. **You can use standard JSON if you wish!**)

While not everything that is available in your `config.hjson` file can be found defaulted in `core/config.js`, a lot is. [Poke around and see what you can find](https://github.com/NuSkooler/enigma-bbs/blob/master/core/config.js)!

### Configuration Sections
Below is a list of various configuration sections. There are many more, but this should get you started:

* [ACS](acs.md)
* [Archivers](archivers.md): Set up external archive utilities for handling things like ZIP, ARJ, RAR, and so on.
* [Email](email.md): System email support.
* [Event Scheduler](event-scheduler.md): Set up events as you see fit!
* [File Base](/docs/filebase/index.md)
* [File Transfer Protocols](file-transfer-protocols.md): Oldschool file transfer protocols such as X/Y/Z-Modem!
* [Message Areas](/docs/messageareas/configuring-a-message-area.md), [Networks](/docs/messageareas/message-networks.md), [NetMail](/docs/messageareas/netmail.md), etc.
* ...and a **lot** more! Explore the docs! If you can't find something, please contact us!

