---
layout: page
title: Configuration Files
---
## General Information
ENiGMA½ configuration files such as the [system config](config-hjson.md), [menus](menu-hjson.md) and [themes](../art/themes.md) are formatted in the [HJSON format](hjson.md).

## Hot-Reload
Nearly all of ENiGMA½'s configuration can be hot-reloaded. That is, a live system can have it's configuration modified and it will be loaded in place.

> :bulb: [Monitoring live logs](../troubleshooting/monitoring-logs.md) is useful when making live changes. The system will complain if something is wrong!

## Common Directives
### Includes
Most configuration files offer an `includes` directive that allows users to break up large configuration files into smaller and organized parts. For example, consider a system with many menus/screens. Instead of a single `menu.hjson`, the SysOp may break this into `message-base.hjson`, `file-base.hjson`, etc.

The `includes` directive may be used the top-level scope of a configuration file:
```hjson
// menu.hjson
{
    includes: [
        message-base.hjson
        file-base.hjson
    ]

    menus: {
        someOtherMenu: {
            // ...
        }
    }
}
```
```hjson
// message-base.hjson
{
    menus: {
        someMessageMenu: {
            // ...
        }
    }
}
```

### References
Often times in a configuration you will find that you're repeating yourself quite a bit. ENiGMA½ provides an `@reference` that can help with this in the form of `@reference:dot.path.to.section`.

Consider `actionKeys` in a menu. Often times you may show a screen and the user presses `Q` or `ESC` to fall back to the previous. Instead of repeating this in many menus, a generic block can be referenced:

```hjson
{
    //  note that 'recycle' here is arbitrary;
    //  only 'menus' and 'prompts' is reserved at this level.
    recycle: {
        prevMenu: [
            {
                keys: [ "escape" ]
                action: @systemMethod:prevMenu
            }
        ]
    }

    menus: {
        someMenu: {
            form: {
                0: {
                    actionKeys: @reference:recycle.prevMenu
                }
            }
        }
    }
}
```

> :information_source: An unresolved `@reference` will be left intact.

### Environment Variables
Especially in a container environment such as [Docker](../installation/docker.md), environment variable access in configuration files can become very handy. ENiGMA½ provides a flexible way to access variables using the `@environment` directive. The most basic form of `@environment:VAR_NAME` produces a string value. Additionally a `:type` suffix can be supplied to coerece the value to a particular type. Variables pointing to a comma separated list can be turned to arrays using an additional `:array` suffix.

Below is a table of the various forms:

| Form | Variable Value | Produces |
|------|----------------|----------|
| `@environment:SOME_VAR` | "Foo" | `"Foo"` (without quotes) |
| `@environment:SOME_VAR` | "123" | `"123"` (without quotes) |
| `@environment:SOME_VAR:string` | "Bar" | `"Bar"` (without quotes) |
| `@environment:SOME_VAR:string:array` | "Foo,Bar" | `[ 'Foo', 'Bar' ]` |
| `@environment:SOME_VAR:boolean` | "1" | `true` |
| `@environment:SOME_VAR:boolean` | "True" | `true` |
| `@environment:SOME_VAR:boolean` | "false" | `false` |
| `@environment:SOME_VAR:boolean` | "cat" | `false` |
| `@environment:SOME_VAR:boolean:array` | "True,false,TRUE" | `[ true, false, true ]` |
| `@environment:SOME_VAR:number` | "123" | `123` |
| `@environment:SOME_VAR:number:array` | "123,456" | `[ 123, 456 ]` |
| `@environment:SOME_VAR:number` | "kitten" | (invalid) |
| `@environment:SOME_VAR:object` | '{"a":"b"}' | `{ 'a' : 'b' }` |
| `@environment:SOME_VAR:object:array` | '{"a":"b"},{"c":"d"}' | `[ { 'a' : 'b' }, { 'c' : 'd' } ]` |
| `@environment:SOME_VAR:timestamp` | "2020-01-05" | A [moment](https://momentjs.com/) object representing 2020-01-05 |
| `@environment:SOME_VAR:timestamp:array` | "2020-01-05,2016-05-16T01:15:37'" | An array of [moment](https://momentjs.com/) objects representing 2020-01-05 and 2016-05-16T01:15:37 |

> :bulb: `bool` may be used as an alias to `boolean`.

> :bulb: `timestamp` values can be in any form that [moment can parse](https://momentjs.com/docs/#/parsing/).

> :information_source: An unresolved or invalid `@environment` will be left intact.

Consider the following fragment:
```hjson
{
    foo: {
        bar: @environment:BAR_VAR:number
    }
}
```

If the environment has `BAR_VAR=1337`, this would produce:
```hjson
{
    foo: {
        bar: 1337
    }
}
```

## See Also
* [System Configuration](config-hjson.md)
* [Menu Configuration](menu-hjson.md)
* [The HJSON Format](hjson.md)
