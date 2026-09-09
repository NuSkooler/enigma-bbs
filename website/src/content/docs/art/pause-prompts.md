---
layout: page
title: Pause Prompts
---
## Pause Prompts

ENiGMA½ supports a flexible pause prompt system that controls how the system waits for user input after displaying art. Pause prompts are fully themeable: they support art files, any MCI view type, and can be customised per-menu.

---

## How It Works

Pause behaviour is configured at two levels:

1. **Menu config** (`config:` block) — controls *whether* to pause, *how* to paginate, *which named prompt* to display, and *where* to position it on screen
2. **Prompt definition** (`prompts:` block) — the named prompt's art, views, and continuation keys

---

## Menu Config Reference

### `pause`

Controls whether and how the system pauses after displaying the menu's art.

| Value | Behaviour |
|-------|-----------|
| `true` or `'end'` | Pause once after all art is displayed. Uses the `pause` system prompt unless `pausePrompt` overrides it. |
| `'pageBreak'` | Paginate the art — display one screenful at a time, showing a page-break prompt between pages. Shows the end-of-art pause after the final page. Uses the `pausePage` system prompt for page breaks and `pause` for the final pause, unless `pausePrompt` overrides them. |
| `'<promptId>'` | Shorthand: pause in end mode using the named prompt. Equivalent to `pause: true` + `pausePrompt: <promptId>`. |
| `false` (or absent) | No pause. |

> :information_source: Art that uses absolute cursor positioning (ANSI sequences with explicit row/col addresses) is detected automatically — `pageBreak` falls back to single-page display for such art.

### `pausePrompt`

Overrides which named prompt is used for pauses on this menu. When absent the system defaults to `pause` (end-of-art) and `pausePage` (page-break).

```hjson
// Same prompt for both end-of-art and page-break pauses:
pausePrompt: myCustomPause

// Different prompts per type:
pausePrompt: {
    end:  myEndPause
    page: myPagePause
}
```

`pausePrompt` takes precedence over the `pause: '<promptId>'` shorthand.

### `pausePosition`

Force the pause prompt to appear at a specific screen position, overriding the computed position (which is normally just below the last line of displayed art).

```hjson
pausePosition: {
    row: 23    // 1-based row
    col: 1     // 1-based column (optional)
}
```

---

## Prompt Definition Reference

Pause prompts live in the `prompts:` block of a menu file, as a top-level sibling of `menus:`. Two system prompts are provided by `main.in.hjson` as defaults.

### `pause`

Displayed at the end of art when `pause: true` (or `pause: 'end'`) is set. A minimal definition is just an art file:

```hjson
prompts: {
    pause: {
        art: pause
        config: {
            trailingLF: no
        }
    }
}
```

### `pausePage`

Displayed between pages when `pause: pageBreak` is set. Supports two special `config` keys in addition to standard prompt config:

| Key | Description |
|-----|-------------|
| `continuousKey` | When pressed, all remaining page-break prompts are skipped and the final end-of-art pause fires immediately. |
| `quitKey` | When pressed, all remaining art and prompts (including the final pause) are cancelled. |

```hjson
prompts: {
    pausePage: {
        art: pause_page
        config: {
            trailingLF: no
            continuousKey: c
            quitKey: q
        }
    }
}
```

---

## Using TickerView in Pause Prompts

Pause prompts support all MCI views, including [TickerView (`%TK`)](views/ticker_view.md). This lets you display animated instructions or banners while waiting for input — a natural pairing for `pausePage` prompts.

Place `%TK1` in the prompt's art file, then configure it under `mci:`:

```hjson
prompts: {
    pausePage: {
        art: pause_page          // art file contains %TK1
        config: {
            trailingLF: no
            continuousKey: c
            quitKey: q
        }
        mci: {
            TK1: {
                text: "Press any key to continue — [C] skip pages — [Q] quit"
                width: 70
                motion: bounce
                tickInterval: 70
            }
        }
    }
}
```

Pipe color codes in `text` are preserved across all non-dynamic motion styles (`bounce`, `reveal`, `typewriter`, `fallLeft`, `fallRight`). Dynamic effects (`rainbow`, `scramble`, `glitch`) intentionally override per-character colors.

---

## Theming

Pause prompts can be overridden per-theme like any other prompt. In `theme.hjson`, set properties under `customization.prompts`:

```hjson
customization: {
    prompts: {
        pausePage: {
            mci: {
                TK1: {
                    text: "|04Press any key...|07"
                    motion: bounce
                    width: 60
                    tickInterval: 60
                }
            }
        }
    }
}
```

The art file can also be placed in your theme directory (`art/themes/<yourTheme>/`) to replace the default.

---

## Examples

<details>
<summary>Simple end-of-art pause (default)</summary>
<div markdown="1">

```hjson
myArtDisplay: {
    art: someart
    config: {
        pause: true
    }
}
```

Uses the `pause` system prompt. No additional configuration required.
</div>
</details>

<details>
<summary>Paginated art with page-break and end pauses</summary>
<div markdown="1">

```hjson
myScroller: {
    art: longscroller
    config: {
        pause: pageBreak
    }
}
```

Uses `pausePage` between pages and `pause` at the end. Both are system defaults — add them to your `prompts:` block to customise.
</div>
</details>

<details>
<summary>Paginated art with a custom page-break prompt</summary>
<div markdown="1">

```hjson
// menu entry:
myScroller: {
    art: longscroller
    config: {
        pause: pageBreak
        pausePrompt: {
            page: myPagePause
        }
    }
}

// prompts block:
prompts: {
    myPagePause: {
        art: mypagepause          // art file includes %TK1
        config: {
            trailingLF: no
            continuousKey: c
            quitKey: q
        }
        mci: {
            TK1: {
                text: "|03--- more ---  [SPACE] continue  [C] skip  [Q] quit"
                width: 60
                motion: bounce
                tickInterval: 65
            }
        }
    }
}
```
</div>
</details>

<details>
<summary>Shorthand: end pause with a named custom prompt</summary>
<div markdown="1">

```hjson
myArtDisplay: {
    art: someart
    config: {
        pause: myFancyPause    // end mode, uses 'myFancyPause' prompt
    }
}
```

Equivalent to `pause: true` + `pausePrompt: myFancyPause`.
</div>
</details>

<details>
<summary>Force pause position to a fixed row</summary>
<div markdown="1">

```hjson
myArtDisplay: {
    art: someart
    config: {
        pause: true
        pausePosition: {
            row: 23
        }
    }
}
```

Useful when art has a specific row reserved for the pause prompt.
</div>
</details>
