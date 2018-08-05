---
layout: page
title: menu.hjson
---
:warning: ***IMPORTANT!*** Before making any customisations, create your own copy of `/config/menu.hjson`, and specify it in the `general` section of `config.hjson`:

````hjson
general: {
    menuFile: yourboardname.hjson
}
````
This document and others will refer to `menu.hjson`. This should be seen as an alias to `yourboardname.hjson`

## The Basics
Like all configuration within ENiGMA½, menu configuration is done in [HJSON](https://hjson.org/) format.

Entries in `menu.hjson` are objects or _sections_ defining a menu. A menu in this sense is something the user can see or visit. Examples include but are not limited to:

* Classical Main, Messages, and File menus
* Art file display
* Module driven menus such as door launchers and other custom mods

Menu entries live under the `menus` section of `menu.hjson`. The *key* for a menu is it's name that can be referenced by other menus and areas of the system.

## Common Menu Entry Members
* `desc`: A friendly description that can be found in places such as "Who's Online" or the `%MD` MCI code.
* `art`: An art file specification.
* `next`: Specifies the next menu to go to next. Can be explicit or an array of possibilites dependent on ACS. See **Flow Control** in the **ACS Checks** section below.
* `prompt`: Specifies a prompt, by name, to use along with this menu.
* `form`: Defines one or more forms available on this menu.
* `submit`: Defines a submit handler when using `prompt`.
* `config`: May contain any of the following standard configuration members in addition to per-module defined types (see appropriate module for more information):
    * `cls`: If `true` the screen will be cleared before showing this menu.
    * `pause`: If `true` a pause will occur after showing this menu. Useful for simple menus such as displaying art or status screens.
    * `nextTimeout`: Sets the number of **milliseconds** before the system will automatically advanced to the `next` menu.
    * `baudRate`: Sets the SyncTERM style emulated baud rate. May be `300`, `600`, `1200`, `2400`, `4800`, `9600`, `19200`, `38400`, `57600`, `76800`, or `115200`. A value of `ulimited`, `off`, or `0` resets (disables) the rate.  See [this specification](https://github.com/protomouse/synchronet/blob/master/src/conio/cterm.txt) for more information.
    * `font`: Sets the SyncTERM style font. May be one of the following: `cp437`, `cp1251`, `koi8_r`,  `iso8859_2`, `iso8859_4`, `cp866`, `iso8859_9`, `haik8`, `iso8859_8`, `koi8_u`, `iso8859_15`, `iso8859_4`, `koi8_r_b`, `iso8859_4`, `iso8859_5`, `ARMSCII_8`, `iso8859_15`, `cp850`, `cp850`, `cp885`, `cp1251`, `iso8859_7`, `koi8-r_c`, `iso8859_4`, `iso8859_1`, `cp866`, `cp437`, `cp866`, `cp885`, `cp866_u`, `iso8859_1`, `cp1131`, `c64_upper`, `c64_lower`, `c128_upper`, `c128_lower`, `atari`, `pot_noodle`, `mo_soul`, `microknight_plus`, `topaz_plus`, `microknight`, `topaz`. See [this specification](https://github.com/protomouse/synchronet/blob/master/src/conio/cterm.txt) for more information.

## Forms
TODO

## Submit Handlers
TODO

## Example
Let's look a couple basic menu entries:

```hjson
telnetConnected: {
    art: CONNECT
    next: matrix
    options: { nextTimeout: 1500 }
}
```

The above entry `telnetConnected` is set as the Telnet server's first menu entry (set by `firstMenu` in the Telnet server's config).

An art pattern of `CONNECT` is set telling the system to look for `CONNECT<n>.*` where `<n>` represents a optional integer in art files to cause randomness, e.g. `CONNECT1.ANS`, `CONNECT2.ANS`, and so on. If desired, you can also be explicit by supplying a full filename with an extention such as `CONNECT.ANS`.

The entry `next` sets up the next menu, by name, in the stack (`matrix`) that we'll go to after `telnetConnected`.

Finally, an `options` object may contain various common options for menus. In this case, `nextTimeout` tells the system to proceed to the `next` entry automatically after 1500ms.

Now let's look at `matrix`, the `next` entry from `telnetConnected`:

```hjson
matrix: {
    art: matrix
    desc: Login Matrix
    form: {
    0: {
        VM: {
        mci: {
            VM1:  {
            submit: true
            focus:  true            
            items: [ "login", "apply", "log off" ]
            argName: matrixSubmit
            }
        }
        submit: {
            *: [
                {
                    value: { matrixSubmit: 0 }
                    action: @menu:login
                }
                {
                    value: { matrixSubmit: 1 },
                    action: @menu:newUserApplication
                }
                {
                    value: { matrixSubmit: 2 },
                    action: @menu:logoff
                }
            ]
        }
        }
    }
    }
}
```

In the above entry, you'll notice `form`. This defines a form(s) object. In this case, a single form 
by ID of `0`. The system is then told to use a block only when the resulting art provides a `VM` 
(*VerticalMenuView*) MCI entry. `VM1` is then setup to `submit` and start focused via `focus: true` 
as well as have some menu entries ("login", "apply", ...) defined. We provide an `argName` for this 
action as `matrixSubmit`.

The `submit` object tells the system to attempt to apply provided match entries from any view ID (`*`).
 Upon submit, the first match will be executed. For example, if the user selects "login", the first entry 
 with a value of `{ matrixSubmit: 0 }` will match causing `action` of `@menu:login` to be executed (go 
 to `login` menu).

## ACS Checks
Menu modules can check user ACS in order to restrict areas and perform flow control. See [ACS](acs.md) for available ACS syntax.

### Menu Access
To restrict menu access add an `acs` key to `config`. Example:
```
opOnlyMenu: {
    desc: Ops Only!
    config: {
        acs: ID1
    }
}
```

### Flow Control
The `next` member of a menu may be an array of objects containing an `acs` check as well as the destination. Depending on the current user's ACS, the system will pick the appropriate target. The last element in an array without an `acs` can be used as a catch all. Example:
```
login: {
    desc: Logging In
    next: [
        {
            //	>= 2 calls else you get the full login
            acs: NC2
            next: loginSequenceLoginFlavorSelect
        }
        {
            next: fullLoginSequenceLoginArt
        }
    ]
}
```