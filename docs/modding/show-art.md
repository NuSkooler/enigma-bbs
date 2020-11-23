---
layout: page
title: The Show Art Module
---
## The Show Art Module
The built in `show_art` module add some advanced ways in which you can configure your system to display art assets beyond what a standard menu entry can provide. For example, based on user selection of a file or message base area.

## Configuration
### Config Block
Available `config` block entries:
* `method`: Set the method in which to show art. See **Methods** below.
* `optional`: Is this art required or optional? If non-optional and we cannot show art based on `method`, it is an error.
* `key`: Used for some `method`s. See **Methods**

### Methods
#### Extra Args
When `method` is `extraArgs`, the module selects an *art spec* from a value found within `extraArgs` that were passed to `show_art` by `key`. Consider the following:

Given an `menu.hjson` entry:
```hjson
showWithExtraArgs: {
    module: show_art
    config: {
        method: extraArgs
        key: fooBaz
    }
}
```
If the `showWithExtraArgs` menu was entered and passed `extraArgs` as the following:
```json
{
    "fizzBang" : true,
    "fooBaz" : "LOLART"
}
```

...then the system would use the *art spec* of `LOLART`.

#### Area & Conferences
Handy for inserting into File Base, Message Conferences, or Mesage Area selections selections. When `method` is `fileBaseArea`, `messageConf`, or `messageArea` the selected conf/area's associated *art spec* is utilized. Example:

Given a file base entry in `config.hjson`:
```hjson
areas: {
    all_ur_base: {
        name: All Your Base
        desc: chown -r us ./base
        art: ALLBASE
    }
}
```

A menu entry may look like this:
```hjson
showFileBaseAreaArt: {
    module: show_art
    config: {
        method: fileBaseArea
        cls: true
        pause: true
        menuFlags: [ "popParent", "noHistory" ]
    }
}
```

...if the user choose the "All Your Base" area, the *art spec* of `ALLBASE` would be selected and displayed.

The only difference for `messageConf` or `messageArea` methods are where the art is defined (which is always next to the conf or area declaration in `config.hjson`).

While `key` can be overridden, the system uses `areaTag` for message/file area selections, and `confTag` for conference selections by default.
