## Configuration
Configuration files in ENiGMA½ are simple UTF-8 encoded [HJSON](http://hjson.org/) files. HJSON is just like JSON but simplified and much more resilient to human error.

### System Configuraiton
The main system configuration file, `config.hjson` both overrides defaults and provides additional configuration such as message areas. The default path is `~/.config/enigma-bbs/config.hjson` though you can override this with the `--config` parameter when invoking `main.js`. Values found in core/config.js may be overridden by simply providing the object members you wish replace.

**Windows note**: **~** resolves to *C:\Users\YOURLOGINNAME\* on modern installations, e.g. *C:\Users\NuSkooler\\.config\enigma-bbs\config.hjson*

#### Example: System Name
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

### Menus
TODO: Documentation on menu.hjson, etc.