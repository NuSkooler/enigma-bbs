## Configuration
Configuration files in ENiGMA½ are simple UTF-8 encoded [HJSON](http://hjson.org/) files. HJSON is just like JSON but simplified and much more resilient to human error.

### System Configuraiton
The main system configuration file, `config.hjson` both overrides defaults and provides additional configuration such as message areas. This file shoudl be created in `~/.config/enigma-bbs/config.hjson`. Values found in core/config.js may be overridden by simply providing the object members you wish replace.

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

TODO: document Windows ~/... path example