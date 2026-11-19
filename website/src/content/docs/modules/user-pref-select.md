---
title: User Preference Select
description: "Let users choose between alternatives you offer, such as which message reader the new scan opens."
sidebar:
    order: 44
---
Some boards offer more than one way to do the same thing: the stock new scan and an index reader mod, two styles of file listing, and so on. The `user_pref_select` module lets each user pick the one they like. Their choice is stored as a **user preference**, and your menus send them the right way with the `PV` ACS code.

There are two parts, and both live in your `menu.hjson`:

1. **Routing:** the menu action that opens the feature becomes a list of ACS-conditional entries, one per alternative, with the board default last.
2. **Offering the choice:** a `user_pref_select` menu (or a plain prompt using [`@systemMethod:setUserPreference`](#the-setuserpreference-system-method)) lets the user set the preference.

Nothing registers itself: you list the choices next to the routing, so you decide what is offered and to whom.

---

## User Preferences

A user preference is a user property whose name starts with **`pref__`** (two underscores), for example `pref__msg_reader`. The prefix is reserved for this use: no built-in property uses it, and the module and system method refuse to write anything outside it, so they can never change properties such as `account_status` or `theme_id`.

Names and values may only use the characters `PV` can test: letters, digits, `-`, `_` and `+`. No `.`, `:` or spaces. A choice that breaks this rule is skipped (with a warning in the log).

A user who has never chosen has no preference at all. That matches no `PV` check, so they get the last entry in your routing list: the **board default**. Choosing "(board default)" removes the preference again, so if you later change your default, those users follow it.

:::note
Mods that keep their own data should use a prefix of their own or their mod database (`getModDatabasePath()`), not `pref__`.
:::

---

## Routing on a Preference

`PV[`*name*`,`*value*`]` is true when the user's property *name* is exactly *value* (see [ACS](../configuration/acs.md)). Turn the action into a list; the first entry whose `acs` matches is used, and the entry without `acs` goes last:

```hjson
{
    value: { command: "!" }
    action: [
        {
            acs: "PV[pref__msg_reader,lampboard]"
            action: @menu:lampboardMain
        }
        {
            action: @menu:mainMenuGlobalNewScan
        }
    ]
}
```

Only `action` is picked from the list; any `extraArgs` belongs to the enclosing entry. So each alternative is a menu entry of its own, and the main menu and login new scan each get their own entries (as the stock `mainMenuGlobalNewScan` and `fullLoginSequenceNewScan` already are).

:::caution[Hjson quoting]
* **Quote the ACS string:** `acs: "PV[pref__msg_reader,lampboard]"`.
* **Keep objects multi-line,** one key per line as above. A comma inside an inline object such as `{ acs: PV[a,b], action: ... }` breaks it.
* Quote any text holding `{tokens}` or a `:`, e.g. `mainInfoFormat10: "|07Now: |15{currentName}"`.
:::

---

## The Module

### Configuration Block

All of these come from `menu.hjson` (or the menu's `config` in `theme.hjson`); nothing the user types can set them.

| Key | Default | Description |
|-----|---------|-------------|
| `pref` | (required) | The preference to set, e.g. `pref__msg_reader`. Must start with `pref__`; the menu will not load otherwise. |
| `choices` | `[]` | The alternatives offered, in order. Each is an object (see below). |
| `defaultText` | `(board default)` | Text of the first entry, which clears the preference. |
| `defaultDesc` | `Use the default this board has chosen` | Its description. |
| `currentIndicator` | `*` | Marks the user's current choice. |
| `notCurrentIndicator` | (a space) | Marks the other entries. |
| `mainInfoFormat10`, `mainInfoFormat11`... | | Formats for the custom `%TL10`+ views. See **MCI Codes**. |

Each entry in `choices`:

| Key | Description |
|-----|-------------|
| `value` | The value stored, and tested with `PV`. Letters, digits, `-`, `_` and `+` only. A number is stored as its text (`value: 2` matches `PV[pref__x,2]`). |
| `text` | What the list shows. Defaults to `value`. |
| `desc` | Shown in `%TL2` while the entry is focused. |
| `acs` | Optional. The choice is only offered to users who pass it, e.g. `"TE[ansi]"` for an alternative that needs ANSI. |

If the stored preference is not one of the choices offered to this user (the choice was removed, or its `acs` no longer passes), "(board default)" is shown as current. The stored preference is left alone until the user picks something.

### Art

No art ships for this module. Point the menu's `art` at your own, with a `%VM1` (or `%TV1`) list and the optional views below.

### MCI Codes

| MCI | Description |
|-----|-------------|
| `%VM1` | The list: "(board default)" first, then each choice offered to this user. A [Table View](../art/views/table_view.md) (`%TV1`) works too. |
| `%TL2` | Description of the focused entry. |
| `%TL10`+ | Custom range, updated on focus change and after a selection, from `mainInfoFormat10` and so on. Takes the item fields below plus `{currentName}` (text of the current choice), `{currentValue}` (its value; empty for the default) and `{pref}`. |

### Item Fields

Available in `itemFormat` / `focusItemFormat` (or as Table View columns) and in the custom range:

| Field | Description |
|-------|-------------|
| `{text}` | The indicator, a space and the entry's text, e.g. `* Classic new scan`. Shown when there is no `itemFormat`. |
| `{name}` | The entry's text without the indicator. |
| `{desc}` | The entry's description. |
| `{value}` | The value it stores; empty for "(board default)". |
| `{currentIndicator}` | `currentIndicator` on the current choice, `notCurrentIndicator` on the others. |
| `{isCurrent}` | `true` on the current choice. |
| `{isDefault}` | `true` on "(board default)". |

### Key Bindings

Bind keys in the form's `actionKeys`:

| Action | Typical key(s) | Description |
|--------|---------------|-------------|
| `@method:select` | `enter`, `space` | Store the focused entry (or clear the preference, for "(board default)"). The list stays up with the new choice marked. |
| `@method:done` | `q`, `escape` | Return to the previous menu. |

---

## The setUserPreference System Method

For a plain "press 1 for this, 2 for that" screen, `@systemMethod:setUserPreference` sets the preference without a list. Its `extraArgs`:

| Key | Description |
|-----|-------------|
| `pref` | The preference, e.g. `pref__msg_reader`. Must start with `pref__`. |
| `value` | The value to store (letters, digits, `-`, `_` and `+`; a number is stored as its text), or `null` to clear the preference so the board default applies again. |
| `next` | Optional. The menu to go to afterwards. Without it, the user goes back to the previous menu. |

`pref` and `value` are only ever taken from `extraArgs`, never from what the user typed. Anything that breaks the rules above is refused: nothing is written, a warning is logged and the user stays where they are.

```hjson
mainMenuChooseReader: {
    desc: Choosing a Reader
    art: CHOOSRDR
    prompt: menuCommand
    submit: [
        {
            value: { command: "1" }
            action: @systemMethod:setUserPreference
            extraArgs: {
                pref: pref__msg_reader
                value: classic
            }
        }
        {
            value: { command: "2" }
            action: @systemMethod:setUserPreference
            extraArgs: {
                pref: pref__msg_reader
                value: lampboard
            }
        }
        {
            value: { command: "D" }
            action: @systemMethod:setUserPreference
            extraArgs: {
                pref: pref__msg_reader
                value: null
            }
        }
        {
            value: { command: "Q" }
            action: @systemMethod:prevMenu
        }
    ]
}
```

---

## Complete Example

This example offers the stock new scan and an index reader mod (`lampboard`, with menu entries `lampboardMain` and `lampboardLogin` from its README) as alternatives. The stock new scan stays the board default; the index reader is offered to ANSI callers only.

**1. Offer the choice.** Add a menu, and a way to reach it (here `R` on the user config menu, but anywhere works):

```hjson
mainMenuReaderPref: {
    desc: Choosing a Reader
    module: user_pref_select
    art: READRPREF
    config: {
        pref: pref__msg_reader
        defaultText: (board default)
        choices: [
            {
                value: classic
                text: Classic new scan
                desc: One message after another, area by area
            }
            {
                value: lampboard
                text: Index reader
                desc: A table of areas with new mail; pick one to read
                acs: "TE[ansi]"
            }
        ]
        mainInfoFormat10: "|07Currently: |15{currentName}"
    }
    form: {
        0: {
            mci: {
                VM1: {
                    focus: true
                    height: 6
                    itemFormat: "|03{currentIndicator} |07{name}"
                    focusItemFormat: "|19|15{currentIndicator} {name}"
                }
                TL2: { }
                TL10: { }
            }
            actionKeys: [
                {
                    keys: [ "enter", "space" ]
                    action: @method:select
                }
                {
                    keys: [ "q", "shift + q", "escape" ]
                    action: @method:done
                }
            ]
        }
    }
}
```

Offering `classic` as an explicit choice is optional: a user who picks it stays on the stock new scan even if you later make the index reader the board default. Leave it out if you only want "index reader" or "whatever the board uses".

**2. Route the main menu's `!`** in `mainMenu`'s `submit`:

```hjson
{
    value: { command: "!" }
    action: [
        {
            acs: "PV[pref__msg_reader,lampboard]"
            action: @menu:lampboardMain
        }
        {
            action: @menu:mainMenuGlobalNewScan
        }
    ]
}
```

**3. Route the login new scan prompt** in `fullLoginSequenceNewScanConfirm`'s `submit`:

```hjson
fullLoginSequenceNewScanConfirm: {
    desc: Logging In
    prompt: loginGlobalNewScan
    submit: [
        {
            value: { promptValue: 0 }
            action: [
                {
                    acs: "PV[pref__msg_reader,lampboard]"
                    action: @menu:lampboardLogin
                }
                {
                    action: @menu:fullLoginSequenceNewScan
                }
            ]
        }
        {
            value: { promptValue: 1 }
            action: @menu:fullLoginSequenceUserStats
        }
    ]
}
```

A user who chose `classic`, chose "(board default)" or never chose gets the stock new scan; a user who chose the index reader gets the mod. To switch the whole board instead, point the actions straight at the mod and skip the preference.

:::tip
To also hide the choice from callers whose terminal cannot show the mod, add the same condition to the routing entry: `acs: "PV[pref__msg_reader,lampboard] & TE[ansi]"`. A choice's `acs` only controls whether it is offered.
:::
