---
layout: page
title: Menu HSJON
---
## Menu HJSON
The core of a ENiGMA½ based BBS is it's menus driven by what will be referred to as `menu.hjson`. Throughout ENiGMA½ documentation, when `menu.hjson` is referenced, we're actually talking about `config/menus/yourboardname-*.hjson`. These files determine the menus (or screens) a user can see, the order they come in, how they interact with each other, ACS configuration, and so on. Like all configuration within ENiGMA½, menu configuration is done in [HJSON](https://hjson.org/) format.

:information_source: See also [HJSON General Information](hjson.md) for more information on the HJSON file format.

:bulb: Entries in `menu.hjson` are often referred to as *blocks* or *sections*. Each entry defines a menu. A menu in this sense is something the user can see or visit. Examples include but are not limited to:

* Classical navigation and menus such as Main, Messages, and Files.
* Art file display.
* Module driven menus such as [door launchers](../modding/local-doors.md), [Onelinerz](../modding/onelinzerz.md), and other custom mods.

Menu entries live under the `menus` section of `menu.hjson`. The *key* for a menu is it's name that can be referenced by other menus and areas of the system.

Below is a very basic menu entry called `showSomeArt` that displays some art then returns to the previous menu after the user hits a key:
```hjson
showSomeArt: {
  art: someart.ans
  config: { pause: true }
}
```
As you can see a menu can be very simple.

:information_source: Remember that the top level menu may include additional files using the `includes` directive. See [Configuration Files](config-files.md) for more information on this.

## Common Menu Entry Members
Below is a table of **common** menu entry members. These members apply to most entries, though entries that are backed by a specialized module (ie: `module: bbs_list`) may differ. Menus that use their own module contain a `module` declaration:

```hjson
module: some_fancy_module
```

See documentation for the module in question for particulars.

| Item   | Description  |
|--------|--------------|
| `desc` | A friendly description that can be found in places such as "Who's Online" or wherever the `%MD` MCI code is used. |
| `art` | An art file *spec*. See [General Art Information](../art/general.md). |
| `next` | Specifies the menu to go to next. Can be explicit or an array of possibilities dependent on ACS. See **Flow Control** in the **ACS Checks** section below. If `next` is not supplied, the next menu is this menus parent. Note that special built in methods such as `@systemMethod:logoff` can also be utilized here. |
| `prompt` | Specifies a prompt, by name, to use along with this menu. Prompts are configured in the `prompts` section. See **Prompts** for more information. |
| `submit` | Defines a submit handler when using `prompt`.
| `form` | An object defining one or more *forms* available on this menu. |
| `module` | Sets the module name to use for this menu. The system ships with many build in modules or you can build your own! |
| `config` | An object containing additional configuration. See **Config Block** below. |

### Config Block
The `config` block for a menu entry can contain common members as well as a per-module (when `module` is used) settings.

| Item | Description |
|------|-------------|
| `cls` | If `true` the screen will be cleared before showing this menu. |
| `pause` | If `true` a pause will occur after showing this menu. Useful for simple menus such as displaying art or status screens. |
| `nextTimeout` | Sets the number of **milliseconds** before the system will automatically advanced to the `next` menu. |
| `baudRate` | See baud rate information in [General Art Information](../art/general.md). |
| `font` | Sets a SyncTERM style font to use when displaying this menus `art`. See font listing in [General Art Information](../art/general.md). |
| `menuFlags` | An array of menu flag(s) controlling menu behavior. See **Menu Flags** below.

#### Menu Flags
The `menuFlags` field of a `config` block can change default behavior of a particular menu.

| Flag | Description |
|------|-------------|
| `noHistory` | Prevents the menu from remaining in the menu stack / history. When this flag is set, when the **next** menu falls back, this menu will be skipped and the previous menu again displayed instead. Example: menuA -> menuB(noHistory) -> menuC: Exiting menuC returns the user to menuA. |
| `popParent` | When *this* menu is exited, fall back beyond the parent as well. Often used in combination with `noHistory`. |
| `forwardArgs` | If set, when the next menu is entered, forward any `extraArgs` arguments to *this* menu on to it. |


## Forms
ENiGMA½ uses a concept of *forms* in menus. A form is a collection of associated *views*. Consider a New User Application using the `nua` module: The default implementation utilizes a single form with multiple EditTextView views, a submit button, etc. Forms are identified by number starting with `0`. A given menu may have mutiple forms (often associated with different states or screens within the menu).

Menus may also support more than one layout type by using a *MCI key*. A MCI key is a alpha-numerically sorted key made from 1:n MCI codes. This lets the system choose the appropriate set of form(s) based on theme or random art. An example of this may be a matrix menu: Perhaps one style of your matrix uses a vertical light bar (`VM` key) while another uses a horizontal (`HM` key). The system can discover the correct form to use by matching MCI codes found in the art to that of the available forms defined in `menu.hjson`.

For more information on views and associated MCI codes, see [MCI Codes](../art/mci.md).

## Submit Handlers
When a form is submitted, it's data is matched against a *submit handler*. When a match is found, it's *action* is performed.

### Submit Actions
Submit actions are declared using the `action` member of a submit handler block. Actions can be kick off system/global or local-to-module methods, launch other menus, etc.

| Action | Description |
|--------|-------------|
| `@menu:menuName` | Takes the user to the *menuName* menu |
| `@systemMethod:methodName` | Executes the system/global method *methodName*. See **System Methods** below. |
| `@method:methodName` | Executes *methodName* local to the calling module. That is, the module set by the `module` member of a menu entry. |
| `@method:/path/to/some_module.js:methodName` | Executes *methodName* exported by the module at */path/to/some_module.js*. |

#### Advanced Action Handling
In addition to simple simple actions, `action` may also be:
* An array of objects containing ACS checks and a sub `action` if that ACS is matched. See **Action Matches** in the ACS documentation below for details.
* An array of actions. In this case a random selection will be made. Example:
```hjson
submit: [
    {
        value: { command: "FOO" }
        action: [
            // one of the following actions will be matched:
            "@menu:menuStyle1"
            "@menu:menuStyle2"
        ]
    }
]
```

#### Method Signature
Methods executed using `@method`, or `@systemMethod` have the following signature:
```
(callingMenu, formData, extraArgs, callback)
```

#### System Methods
Many built in global/system methods exist. Below are a few. See [system_menu_method](/core/system_menu_method.js) for more information.

| Method | Description |
|--------|-------------|
| `login` | Performs a standard login. |
| `login2FA_OTP` | Performs a 2-Factor Authentication (2FA) One-Time Password (OTP) check, if configured for the user. |
| `logoff` | Performs a standard system logoff. |
| `prevMenu` | Goes to the previous menu. |
| `nextMenu` | Goes to the next menu (as set by `next`) |
| `prevConf` | Sets the users message conference to the previous available. |
| `nextConf` | Sets the users message conference to the next available. |
| `prevArea` | Sets the users message area to the previous available. |
| `nextArea` | Sets the users message area to the next available. |

## Example
Let's look a couple basic menu entries:

```hjson
telnetConnected: {
    art: CONNECT
    next: matrix
    config: { nextTimeout: 1500 }
}
```

The above entry `telnetConnected` is set as the Telnet server's first menu entry (set by `firstMenu` in the Telnet server's config). The entry sets up a few things:
* A `art` spec of `CONNECT`. (See [General Art Information](../art/general.md)).
* A `next` entry up the next menu, by name, in the stack (`matrix`) that we'll go to after `telnetConnected`.
* An `config` block containing a single `nextTimeout` field telling the system to proceed to the `next` (`matrix`) entry automatically after 1500ms.

Now let's look at `matrix`, the `next` entry from `telnetConnected`:

```hjson
matrix: {
    art: MATRIX
    desc: Login Matrix
    form: {
        0: {
            //
            //  Here we have a MCI key of "VM". In this case we could
            //  omit this level since no other keys are present.
            //
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

            //
            //  If we wanted, we could declare a "HM" MCI key block here.
            //  This would allow a horizontal matrix style when the matrix art
            //  loaded contained a %HM code.
            //
        }
    }
}
```

In the above entry, you'll notice `form`. This defines a form(s) object. In this case, a single form by ID of `0`. The system is then told to use a block only when the resulting art provides a `VM` (*VerticalMenuView*) MCI entry. Some other bits about the form:

* `VM1` is then setup to `submit` and start focused via `focus: true` as well as have some menu entries ("login", "apply", ...) defined. We provide an `argName` of `matrixSubmit` for this element view.
* The `submit` object tells the system to attempt to apply provided match entries from any view ID (`*`).
* Upon submit, the first match will be executed. For example, if the user selects "login", the first entry with a value of `{ matrixSubmit: 0 }` will match (due to 0 being the first index in the list and `matrixSubmit` being the arg name in question) causing `action` of `@menu:login` to be executed (go to `login` menu).

## Prompts
Prompts are found in the `prompts` section of menu files. Prompts allow for quick user input and shorthand form requirements for menus. Additionally, prompts are often used for for multiple menus. Consider a pause prompt or menu command input for example.

TODO: additional prompt docs

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

### Action Matches
Action blocks (`action`) can perform ACS checks:
```
// ...
{
    action: [
        {
            acs: SC1
            action: @menu:secureMenu
        }
        {
            action: @menu:nonSecureMenu
        }
    ]
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

### Art Asset Selection
Another area in which you can apply ACS in a menu is art asset specs.

```hjson
someMenu: {
    desc: Neato Dorito
    art: [
        {
            acs: GM[couriers]
            art: COURIERINFO
        }
        {
            //  show ie: EVERYONEELSE.ANS to everyone else
            art: EVERYONEELSE
        }
    ]
}
```

## Case Study: Adding a Sub Menu to Main
A very common task: You want to add a new menu accessible from "Main". First, let's create a new menu called "Snazzy Town"! Perhaps under the `mainMenu` entry somewhere, create a new menu:

```hjson
snazzyTown: {
    desc: Snazzy Town
    art: snazzy
    config: {
        cls: true
        pause: true
    }
}
```

Now let's make it accessible by "S" from the main menu. By default the main menu entry is named `mainMenu`. Within the `mainMenu`'s `submit` block you will see some existing action matches to "command". Simply add a new one pointing to `snazzyTown`:

```hjson
{
    value: { command: "S" }
    action: @menu:snazzyTown
}
```

That's it! When users type "S" at the main menu, they'll be  sent to the Snazzy Town menu. Since we did not supply additional flow logic when they exit, they will fall back to main.

## Case Study: Adding a New User Password (NUP)
You've got a super 31337 board and want to prevent lamerz! Let's run through adding a NUP to your application flow.

Given the default menu system, two "pre" new user application menus exist due to the way Telnet vs SSH logins occur. We'll focus only on Telnet here. This menu is `newUserApplicationPre`. Let's say you want to display this preamble, but then ask for the NUP. If the user gets the password wrong, show them a `LAMER.ANS` and boot 'em.

First, let's create a new menu for the NUP:
```hjson
newUserPassword: {
    art: NUP.ANS
    next: newUserApplication
    desc: NUP!

    form: {
        0: {
            mci: {
                ET1: {
                    // here we create an argument/variable of "nup"
                    argName: nup
                    focus: true
                    submit: true
                }
            }
            submit: {
                *: [
                    {
                        // if the user submits "nup" with the correct
                        // value of "nolamerz" action will send
                        // them to the next menu defined above --
                        // in our case: newUserApplication
                        value: { nup: "nolamerz" }
                        action: @systemMethod:nextMenu
                    }
                    {
                        // anything else will result in going to the badNewUserPassword menu
                        value: { nup: null }
                        action: @menu:badNewUserPassword
                    }
                ]
            }
        }
    }
}
```

Looks like we'll need a `badNewUserPassword` menu as well! Let's create a very basic menu to show art then disconnect the user.

```hjson
badNewUserPassword: {
    art: LAMER.ANS
    // here we use a built in system method to boot them.
    next: @systemMethod:logoff
    config: {
        //  wait 2s after showing the art before kicking them
        nextTimeout: 2000
    }
}
```

Great, we have a couple new menus. Now let's just point to them. Remember the existing `newUserApplicationPre` menu? All that is left to do is point it's `next` to our `newUserPassword` menu:

```hjson
newUserApplicationPre: {
    //  easy! Just tell the system where to go next
    next: newUserPassword
    // note that the rest of this menu is omitted for clarity
}
```
