---
layout: page
title: oputil
---
## The oputil CLI
ENiGMA½ comes with `oputil.js` henceforth known as `oputil`, a command line interface (CLI) tool for sysops to perform general system and user administration. You likely used oputil to do the initial ENiGMA configuration.

Let's look the main help output as per this writing:

```
usage: optutil.js [--version] [--help]
                  <command> [<args>]

global args:
  -c, --config PATH         specify config path (./config/)
  -n, --no-prompt           assume defaults/don't prompt for input where possible

commands:
  user                      user utilities
  config                    config file management
  fb                        file base management
  mb                        message base management
```

Commands break up operations by groups. Type `./oputil.js <command> --help` for additional help on a particular command. The next sections will describe them.

## User
```
usage: optutil.js user <action> [<args>]

actions:
  pw USERNAME PASSWORD         set password to PASSWORD for USERNAME
  rm USERNAME                  permanantely removes USERNAME user from system
  activate USERNAME            sets USERNAME's status to active
  deactivate USERNAME          sets USERNAME's status to deactive
  disable USERNAME             sets USERNAME's status to disabled
  group USERNAME [+|-]GROUP    adds (+) or removes (-) USERNAME from GROUP
```

| Action    | Description       | Examples                              | Aliases   |
|-----------|-------------------|---------------------------------------|-----------|
| `pw`        | Set password      | `./oputil.js user pw joeuser s3cr37`  | `pass`, `passwd`, `password` |
| `rm`        | Removes user      | `./oputil.js user del joeuser`        | `remove`, `del`, `delete` |
| `activate` | Activates user    | `./oputil.js user activate joeuser`   | N/A   |
| `deactivate`    | Deactivates user  | `./oputil.js user deactivate joeuser` | N/A   |
| `disable`   | Disables user (user will not be able to login)    | `./oputil.js user disable joeuser`    | N/A   |
| `group`   | Modifies users group membership   | Add to group: `./oputil.js user group joeuser +derp`<br/>Remove from group: `./oputil.js user group joeuser -derp`   | N/A    |
