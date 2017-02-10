# Menu System
ENiGMA½'s menu system is highly flexible and moddable. The possibilities are almost endless! By modifying your `menu.hjson` you will be able to create a custom look and feel unique to your board.

The default `menu.hjson` file lives within the `mods` directory. It is **highly recommended** to specify another file by setting the `menuFile` property in your `config.hjson` file:
```hjson
general: {
  /* Can also specify a full path */
  menuFile: mybbs.hjson
}
```
(You can start by copying the default `menu.hjson` to `mybbs.hjson`)

## The Basics
Like all configuration within ENiGMA½, menu configuration is done via a HJSON file. This file is located in the `mods` directory: `mods/menu.hjson`.

Each entry in `menu.hjson` defines an object that represents a menu. These objects live within the `menus` parent object. Each object's *key* is a menu name you can reference within other menus in the system. 

## Example
Let's look a couple basic menu entries:

```hjson
telnetConnected: {
  art: CONNECT
  next: matrix
  options: { nextTimeout: 1500 }
}
```

The above entry `telnetConnected` is set as the Telnet server's first menu entry (set by `firstMenu` in the server's config).

An art pattern of `CONNECT` is set telling the system to look for `CONNECT<n>` in the current theme location, then in the common `mods/art` directory where `<n>` represents a optional integer in art files to cause randomness, e.g. `CONNECT1.ANS`, `CONNECT2.ANS`, and so on. You can be explicit here if desired, by specifying a file extension.

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
          }
        }
        submit: {
          *: [
              {
                  value: { 1: 0 }
                  action: @menu:login
              }
              {
                  value: { 1: 1 },
                  action: @menu:newUserApplication
              }
              {
                  value: { 1: 2 },
                  action: @menu:logoff
              }
          ]
        }
      }
    }
  }
}
```

In the above entry, you'll notice `form`. This defines a form(s) object. In this case, a single form by ID of `0`. The system is then told to use a block only when the resulting art provides a `VM` (*VerticalMenuView*) MCI entry. `VM1` is then setup to `submit` and start focused via `focus: true` as well as have some menu entries ("login", "apply", ...) defined.

The `submit` object tells the system to attempt to apply provided match entries from any view ID (`*`). Upon submit, the first match will be executed. For example, if the user selects "login", the first entry with a value of `{ 1: 0 }` or view ID 1, value 0 will match causing `action` of `@menu:login` to be executed (go to `login` menu).