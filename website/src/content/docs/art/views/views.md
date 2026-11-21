---
title: Views
description: "What views are, the properties they share, and an index of every view type."
sidebar:
    order: 10
---
Views are the interactive and display widgets that make up ENiGMA½ screens. They are placed in art files using [MCI codes](../mci.md) and configured via `menu.hjson` and `theme.hjson`. Every element a user sees or interacts with — a text label, an input field, a menu list — is a view.

## General Information

:::note
Views are instantiated by placing an MCI code in an art file. The code determines the view type; an optional number suffix ties it to a specific view ID. For example: `%VM1` creates a Vertical Menu View with ID 1.
:::

:::note
Standard and focus colors are set by placing duplicate MCI codes back-to-back in the art file. The first occurrence sets the normal color, the second sets the focused color.
:::

:::note
See [MCI](../mci.md) for general information on MCI codes and the common configuration properties shared by all views.
:::

## Common View Properties

Every view accepts the following. Individual view pages document only what they
add on top of these.

| Property | Description |
|----------|-------------|
| `focus` | If set to `true`, this view receives initial focus when the screen loads |
| `submit` | If set to `true`, an `accept` action on this view will submit the enclosing **form** |
| `argName` | The key name used to identify this view's value in a submitted form |
| `width` | Width of the view in columns |
| `height` | Height of the view in rows (where applicable) |
| `justify` | Justification of content: `left` (default), `right`, or `center` |
| `fillChar` | Character used to fill space the content does not occupy. Defaults to a space |
| `textStyle` | Standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md) |
| `focusTextStyle` | Text style when the view has focus. See **Text Styles** in [MCI](../mci.md) |

## Common Menu View Properties

The six **menu views** — [Horizontal](horizontal_menu_view.md),
[Vertical](vertical_menu_view.md), [Full](full_menu_view.md),
[Toggle](toggle_menu_view.md), [Spinner](spinner_menu_view.md) and
[Table](table_view.md) — all derive from the same base and therefore accept
everything above **plus** the following. The Table View does not support
`focusItems`, `itemSpacing` or `itemHorizSpacing`.

| Property | Description |
|----------|-------------|
| `items` | The list of items to show. See **Items** below |
| `focusItems` | An alternate list used when an item is focused, parallel to `items` |
| `itemFormat` | Format applied to a list entry. See **Entry Formatting** in [MCI](../mci.md) |
| `focusItemFormat` | Format applied to the focused list entry |
| `focusItemIndex` | Index of the item focused when the view is first drawn |
| `hotKeys` | Map of characters to item indexes. See **Hot Keys** below |
| `hotKeySubmit` | If `true`, selecting via a hot key also submits the form |
| `itemSpacing` | Blank rows (or columns, for horizontal layouts) between items |
| `itemHorizSpacing` | Horizontal spacing between items where the view lays out in columns |
| `textOverflow` | String used to indicate a truncated item, e.g. `"..."` |
| `sort` | Sort the items. `true` sorts on the displayed text, or supply a key name to sort on that field |

:::note
Both tables are derived from `View` and `MenuView` in `core/`, so anything listed
here works on every view of that kind — including combinations an individual
view's page does not show an example of.
:::

### Hot Keys

`hotKeys` lets a user press a character to select an item directly, and
`hotKeySubmit` submits the form when they do:

```hjson
hotKeys: { A: 0, B: 1, C: 2, D: 3 }
hotKeySubmit: true
```

This selects and submits the first item on `A`, the second on `B`, and so on.

### Items

Menu views take a list of items to display. The long form carries a `data` value
submitted with the form, separate from the `text` shown on screen:

```hjson
items: [
  {
      text: First Item
      data: first
  }
  {
      text: Second Item
      data: second
  }
]
```

If the list is display-only — no form action is attached to it — the `data`
element can be omitted and the items given as a plain list:

```hjson
items: [ "First item", "Second item", "Third Item" ]
```

---

## View Types

### Display Views

| View | MCI Code | Description |
|------|----------|-------------|
| [Text View](text_view.md) | `%TL` | A static single-line text label |
| [Ticker View](ticker_view.md) | `%TK` | A continuously scrolling marquee |
| [Status Bar View](status_bar_view.md) | `%SB` | An auto-refreshing text label |

### Input Views

| View | MCI Code | Description |
|------|----------|-------------|
| [Edit Text View](edit_text_view.md) | `%ET` | A single-line text input field |
| [Mask Edit Text View](mask_edit_text_view.md) | `%ME` | A single-line input field constrained by a pattern (e.g. dates, phone numbers) |
| [Multi Line Edit Text View](multi_line_edit_text_view.md) | `%MT` | A full multi-line text editor |
| [Button View](button_view.md) | `%BN` | A labeled button that triggers an action when activated |

### Selection / Menu Views

| View | MCI Code | Description |
|------|----------|-------------|
| [Horizontal Menu View](horizontal_menu_view.md) | `%HM` | A single-row horizontal list of selectable items |
| [Vertical Menu View](vertical_menu_view.md) | `%VM` | A scrolling vertical list, similar to a lightbar menu |
| [Full Menu View](full_menu_view.md) | `%FM` | A paginated multi-column grid of selectable items |
| [Toggle Menu View](toggle_menu_view.md) | `%TM` | A two-item toggle, typically used for Yes/No or On/Off choices |
| [Spinner Menu View](spinner_menu_view.md) | `%SM` | A single-item rotary selector that cycles through a list |
| [Table View](table_view.md) | `%TV` | A scrolling list with columns, group rows, an optional header and sorting |

---

## Class Hierarchy

The following diagram shows the inheritance relationships between all view types. All views ultimately extend Node.js's `EventEmitter` through the base `View` class.

```mermaid
classDiagram
    direction TB

    class EventEmitter {
        <<nodejs>>
    }

    class View {
        +id
        +client
        +position
        +dimens
        +hasFocus bool
        +acceptsFocus bool
        +acceptsInput bool
        +cursor string
        +cursorStyle string
        +ansiSGR
        +ansiFocusSGR
        +styleSGR1
        +styleSGR2
        +specialKeyMap
        +setPosition()
        +setDimension()
        +setFocus(focused)
        +redraw()
        +drawInBackground(drawFn)
        +setBackgroundInterval(fn, ms)
        +clearBackgroundInterval(handle)
        +forceNextRedraw()
        +destroy()
        +isDestroyed(view)$
        +suspendBackgroundDraw(client)$
        +resumeBackgroundDraw(client, token, options)$
        +restoreFocusPosition()
        +restoreFocusCursor()
        +onKeyPress(ch, key)
        +getData()
        +setPropertyValue(name, val)
    }

    class TextView {
        +text string
        +maxLength int
        +fillChar char
        +justify string
        +horizScroll bool
        +textOverflow string
        +textMaskChar char
        +itemFormat string
        +focusItemFormat string
        +setText(text)
        +clearText()
        +drawText(s)
    }

    class TickerView {
        +tickInterval int
        +scrollDir string
        +fillChar char
        +setText(text)
        +forceNextRedraw()
        +destroy()
    }

    class StatusBarView {
        +refreshInterval int
        +setText(text)
        +destroy()
    }

    class EditTextView {
        +cursorPos
        +onKeyPress(ch, key)
        +setText(text)
        +clientBackspace()
    }

    class MaskEditTextView {
        +maskPattern string
        +patternArray
        +patternArrayPos int
        +cursorPos
        +setMaskPattern(pattern)
        +buildPattern()
        +onKeyPress(ch, key)
    }

    class ButtonView {
        +submitData
        +justify
        +onKeyPress(ch, key)
        +getData()
    }

    class MultiLineEditTextView {
        +textBuffer
        +wordWrap bool
        +lineCount
        +onKeyPress(ch, key)
        +getData()
        +addText(text, options)
        +redrawChanged()
        +destroy()
    }

    class KeyEntryView {
        +keys
        +caseInsensitive bool
        +eatTabKey bool
        +keyEntered char
        +onKeyPress(ch, key)
        +getData()
    }

    class MenuView {
        +items
        +focusedItemIndex int
        +itemSpacing int
        +itemHorizSpacing int
        +focusPrefix string
        +focusSuffix string
        +fillChar char
        +hotKeys
        +itemFormat string
        +focusItemFormat string
        +complexItems bool
        +renderCache
        +setItems(items)
        +getItem(index)
        +focusNext()
        +focusPrevious()
        +focusFirst()
        +focusLast()
        +setHotKeys(keys)
        +setSort(sort)
    }

    class HorizontalMenuView {
        +drawItem(index)
        +cachePositions()
        +redraw()
    }

    class VerticalMenuView {
        +focusItemAtTop bool
        +maxVisibleItems int
        +viewWindow
        +autoAdjustHeight bool
        +drawItem(index)
        +updateViewVisibleItems()
        +focusNextPageItem()
        +focusPreviousPageItem()
    }

    class FullMenuView {
        +pages
        +currentPage int
        +itemsPerRow int
        +drawItem(index)
        +cachePositions()
        +clearPage()
        +focusNextColumn()
        +focusPreviousColumn()
    }

    class ToggleMenuView {
        +exactlyTwoItems
        +setTrue()
        +setFalse()
        +isTrue()
        +setFromBoolean(bool)
        +setYes()
        +setNo()
    }

    class TableView {
        +columns
        +columnOrder
        +sort
        +viewWindow
        +setItems(items, options)
        +updateItem(key, patch)
        +updateItemAt(index, patch)
        +focusNextMatching(pred, options)
        +setSort(column, order)
        +cycleSort()
        +toggleSortOrder()
        +setDefaults(defaults)
    }

    class SpinnerMenuView {
        +drawItem(index)
        +updateSelection()
        +focusNext()
        +focusPrevious()
    }

    EventEmitter <|-- View
    View <|-- TextView
    View <|-- TickerView
    View <|-- MenuView
    View <|-- MultiLineEditTextView
    View <|-- KeyEntryView
    TextView <|-- EditTextView
    TextView <|-- MaskEditTextView
    TextView <|-- StatusBarView
    TextView <|-- ButtonView
    MenuView <|-- HorizontalMenuView
    MenuView <|-- VerticalMenuView
    MenuView <|-- FullMenuView
    MenuView <|-- ToggleMenuView
    MenuView <|-- SpinnerMenuView
    MenuView <|-- TableView
```

---

## How Views Fit Together

Views are placed on screen via MCI codes in an art file. They are grouped into **forms** — a form collects input from one or more views and submits the result as a set of named key/value pairs (each view's `argName` maps to its `getData()` result).

The general flow is:

1. An art file is loaded and MCI codes are scanned to instantiate views
2. Views are configured from `menu.hjson` (per-entry `config`) and `theme.hjson` (styling)
3. Focus cycles through views that have `acceptsFocus: true`, driven by Tab / arrow keys
4. When a view with `submit: true` receives an `accept` action, the form is submitted
5. The submitted form data drives the next menu action or module behaviour

:::note
See [MCI](../mci.md) for details on formatting, text styles, and how MCI codes relate to menus and themes.
:::

### Views that draw on a timer

A view that redraws on its own timer, as [TickerView](ticker_view.md) and a [StatusBarView](status_bar_view.md) with `refreshInterval` do, draws while the user may be typing into another view. Drawing moves the terminal cursor and leaves the drawing view's color set, and a text entry view echoes the next key wherever the cursor is, in whatever color is set. Use `setBackgroundInterval()` for the timer:

```js
this._timer = this.setBackgroundInterval(() => {
    this.setText(this._format, false); //  update the state: no drawing here
    if (this.text !== this._lastRendered) {
        this._lastRendered = this.text;
        return () => this.redraw(); //  what to draw, if anything
    }
}, this.refreshInterval);
```

`setBackgroundInterval(fn, ms)` calls `fn()` every `ms`. `fn` updates the view and returns a function that draws the change, or nothing when there is nothing to draw; that function is run through `drawInBackground()` (below). It returns the timer's handle, or `null` on a view that has already been destroyed (no timer is started). `destroy()` clears every background interval the view has, so a view whose form is torn down stops on its own; `clearBackgroundInterval(handle)` stops one sooner (a changed interval, say). A timer of your own (`setInterval()`) works too: draw from it through `drawInBackground()`, and clear it in your `destroy()`.

A view with a timer, a listener or anything else that outlives a draw overrides `destroy()` to stop it, and calls `super.destroy()`: the base `destroy()` clears the background intervals and marks the view destroyed (`View.isDestroyed(view)`), so no redraw is owed to it after a cover. A view that does not override `destroy()` gets the base one, which is enough for background intervals. `destroy()` may be called more than once; make yours safe to repeat.

`drawInBackground(drawFn)` hides the cursor, runs `drawFn`, then calls `restoreFocusCursor()` on the view that has input focus (the view last given focus, on any of the screen's forms), and sends it all in one write; if `drawFn` throws, the cursor is still put back before the error goes on to the caller. `restoreFocusCursor()` calls `restoreFocusPosition()`, which puts the cursor and color back where that view echoes its next key, then shows or hides the cursor as the view's `cursor` property says. `EditTextView` returns to its edit position, `MultiLineEditTextView` (the full screen editor) to its edit row and column, `TextView` and its subclasses to where `setFocus(true)` leaves the cursor; the base `View` does not move it. Override `restoreFocusPosition()` in a focusable view that knows where its cursor belongs. A menu module's `updateCustomViewTextsWithFilter()` uses the same `restoreFocusPosition()` after redrawing custom views. When no view has focus the cursor is left where `drawFn` leaves it. A pause prompt waiting for its key counts as that: it sets the input focus aside while it waits (`View.suspendInputFocus(client)`, given back with `View.resumeInputFocus(client, token)`), so a ticker in the pause art leaves the cursor alone even when a menu form under the pause still has a focused field. Use the same pair around anything else that takes the screen without taking typing.

While art is drawn with baud emulation (a drip: `dripWrite()` and the like), background drawing is paused for every view that was already there when the art started, as it is under a cover (below): a tick drawn between two pieces of the art would move the cursor the art carries on from. A view that missed a draw is drawn once when the art is done. Other output during the art goes out at once, as it always has.

`drawFn` should only draw. Change the view's state (add a line, advance a frame) before calling `drawInBackground()`, not inside `drawFn`: while the screen is covered (below), `drawFn` still runs but its output is thrown away, and a terminal that cannot discard output skips it.

### When something covers the screen

A realtime interrupt, a help page (the full screen editor's Ctrl-O help, the file list's and the WFC's) and a pause prompt that clears the screen are drawn over a menu whose forms are still attached. While one is up (for a clear-screen pause, while it waits for its key):

* **Background drawing is paused** for the views that existed when the cover began, so a ticker or status bar under it does not draw over it. A view that would have drawn meanwhile gets one full redraw when the cover ends (unless the menu is about to repaint anyway, as a reload after an interrupt does). Before that redraw, `forceNextRedraw()` is called on the view: override it in a view that skips output it believes is already on screen. `TickerView` does, so an unchanged frame is drawn again after a cover.
* **Views created inside the cover keep drawing.** A ticker in a pause prompt shown over an interrupt (the stock `pausePage` has one) animates while the menu's ticker under it waits.
* **Keys go to the cover,** not to the forms under it, for an interrupt or a help page: the key that dismisses it is not typed into a field or run as an action underneath. See [Input capture](#input-capture). A pause prompt (one that clears the screen, or one on the same screen) is a plain `client.waitForKeyPress()` and takes no keys from the forms: its key reaches them too, as it always has.

A clear-screen prompt that does not pause (one that takes input, such as an `ET` field) suspends nothing: once it is drawn, the module showing it owns the screen, as before.

For views of your own, `View.suspendBackgroundDraw(client)` returns a token and `View.resumeBackgroundDraw(client, token, { redrawMissed })` gives it back. Suspends nest. `redrawMissed: false` skips the redraw when you replace the screen next. Most code wants `coverScreen()` instead, which does both this and input capture (see [Covers and input capture](../../modding/menu-modules.md#covers-and-input-capture)).

A view whose state changes outside a timer, such as a chat log filled by lines arriving from a server, adds the text without drawing and draws from `drawInBackground()`. `MultiLineEditTextView` has a pair for this:

```js
chatLogView.addText(line, { scrollMode: 'end', redraw: false });
chatLogView.drawInBackground(() => chatLogView.redrawChanged());
```

`addText(text, { redraw: false })` changes the text only; `redrawChanged()` draws the rows that changed since the view was last drawn (all of it if it scrolled). Lines that arrive while the screen is covered are kept, and drawn when it is uncovered.

### Input capture

While something owns the screen, it can own the keys too. `client.captureInput(handler, options)` makes `handler(ch, key)` the receiver of every key and returns a token; `client.releaseInput(token)` gives the keys back. While any capture is held, only the newest one gets keys, and no form's key handler runs: the forms stay attached, they just see nothing. `client.hasInputCapture()` says whether a capture is held. Direct `key press` listeners on the client (a door's own key handling) still see every key, as before.

`options`:

| Option | Description |
|--------|-------------|
| `onMenuChange` | What happens to the capture if the caller is moved to another menu while it is held (a sysop break-in, a time-up). `'passThrough'` (the default): the handler keeps getting every key, alongside the new menu, until you release it. `'drop'`: the capture is dropped and the handler never called (what a cover's own capture does). |
| `onDrop` | Called if the capture is dropped rather than released (the caller hung up, or `'drop'` above). The handler will never be called; clean up here. |

`client.waitForKeyPress(cb)` is not a capture. It is a plain `once('key press')`, as it always was: `cb(ch, key)` gets the next key, in the order the listeners were added, and that key also reaches every other listener, including a form still attached under whatever is waiting. Several waits pending at once all get the same key. To keep the key from the forms, wait inside a cover (`coverScreen()`, see [Covers and input capture](../../modding/menu-modules.md#covers-and-input-capture)), whose capture silences them for every key until it ends, including the one that ends it; or take a capture of your own.

A capture taken while a key is being delivered (a form's action opens a help page) is for the next key; the listeners after it still see the current one.
