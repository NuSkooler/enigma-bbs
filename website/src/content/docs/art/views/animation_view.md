---
title: Animation View
description: "%AV — frames played in a box over a menu's art."
sidebar:
    order: 24
---
An animation view plays a set of frames in a fixed box on top of a menu's art while the menu goes on taking input: flickering fire pillars beside a logo, an eye that glints now and then, a spinner next to a prompt. The frames come from the menu config (pipe-coded strings) or from art files, and each frame after the first is drawn by sending only the cells that changed.

## General Information

:::note
An animation view is defined with a percent (%) and the characters AV, followed by the view number. For example: `%AV20`
:::

:::note
See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.
:::

:::tip
To animate the selected item of a menu list instead (an arrow that pulses beside it, brackets that bounce around it), use `focusItemFrames` on the list itself. See [Animated Focused Item](views.md#animated-focused-item).
:::

The animation starts when the screen is drawn and stops when the screen goes away. It is never focused and takes no input: it is left out of the focus order and of the form's submitted data, and it is never picked as the form's [submit view](../mci.md#the-submit-view). Keys go to the menu's other views as if it were not there.

### Placing the box

There are two ways to say where the box goes:

* **A marker in the art.** `%AV20` in the art marks the top-left cell of the box. The marker itself is replaced by blanks, in the colour just before it, and the box is drawn from the marker's first cell. Leave the rest of the box blank in the art, or draw the resting frame there.
* **A `position` in config, with no marker.** `position: { row: 9, col: 23 }` in the view's `mci` block places the box there, counted from the art's top-left corner. This is the way to animate part of existing art without touching it. See [Placing Views from Configuration](../mci.md#placing-views-from-configuration).

The box's size always comes from config: `width` and `height` are required, and every frame is that size. A frame larger than the box is clipped (with a warning in the log); a smaller one is padded with blanks.

### View IDs

Use IDs from **20 up** for animation views. View IDs are per number, not per code: `AV1` and `VM1` are the same view ID, so an `AV1` on a menu that has a `%VM1` clashes with it (the second is skipped, with a `Duplicate MCI view ID` warning). And when no view sets `focus: true`, a form gives the initial focus to view 1: if view 1 is an animation, which never takes focus, nothing on the form is focused.

Adding an `%AV` marker to a menu's art does not change which form config the menu picks: `AV` is not part of the art's MCI key (see **Forms** in [Menu HJSON](../../configuration/menu-hjson.md#forms)).

### Properties

| Property | Description |
|----------|-------------|
| `width` | Width of the box, and of every frame, in columns. **Required.** |
| `height` | Height of the box, and of every frame, in rows. **Required.** |
| `frames` | Where the frames come from. See **Frame Sources** below. **Required.** |
| `frameInterval` | Milliseconds each frame shows (default: `100`). |
| `frameDurations` | A list of milliseconds, one per frame, for frames that should show longer or shorter than `frameInterval`. An entry that is missing or `null` uses `frameInterval`. |
| `mode` | The order frames play in: `loop`, `pingpong`, `once` or `random`. See **Modes** below. Default: `loop`. |
| `startFrame` | The frame (counted from `0`) the animation starts on. Default: `0`. Two copies of one animation with different `startFrame` values stay out of step with each other. |
| `idle` | A wait on frame 0, in milliseconds: one number, or `[ min, max ]` for a random wait between the two. See **Idle** below. Default: off. |
| `transparent` | A single character. A cell that holds this character in **every** frame is never drawn, so the art under it shows through. See **Transparency** below. |
| `position` | `{ row, col }`: places the box with no marker in the art. See **Placing the box** above. |

A value that is not valid (a `mode` that does not exist, a `frameInterval` of `"fast"`) is logged as a warning and the default is used. Nothing in an animation's config can stop the menu from loading.

---

### Frame Sources

`frames` takes one of three shapes.

#### Inline frames

A list of strings, one per frame, using [pipe colour codes](../colour-codes.md). Separate the rows of a frame with `\n`. No art files are needed, which suits small things: a spinner, a scanner bar, a word that bounces.

```hjson
frames: [
    "|11|16■|08|16····\n|03|16■|07|16 |14|16½|07|16 |08|16·\n|03|16·|08|16····"
    "|03|16■|11|16■|08|16···\n|03|16·|07|16 |14|16½|07|16 |08|16·\n|08|16·····"
]
```

Each frame starts from a colour reset (normally grey on black), not from the colour the previous frame or the art ended on, so set the colours each frame needs at its start (`|16` is a black background).

#### A frame sheet

One art file holding every frame, stacked from top to bottom. `art` names the file; the other keys say where the frames are in it:

| Key | Description |
|-----|-------------|
| `art` | The sheet's art name. |
| `row`, `col` | Where frame 0's top-left corner is in the sheet, counted from 1 (default: `1`, `1`). |
| `gap` | Blank rows between one frame and the next (default: `0`). A gap makes it easier to see where frames start while drawing the sheet. |
| `frameCount` | Take at most this many frames (default: as many as fit). |

Frame *n* starts `n × (height + gap)` rows below frame 0, and is `width` columns wide from `col`. So a sheet of six 8x9 frames with a one-row gap is 59 rows tall.

* The number of frames comes from the rows the sheet **actually draws**, never from its SAUCE record. The SAUCE record, its comments and the end-of-file marker do not add a row or a short frame.
* Rows left over at the bottom that are not a whole frame are dropped, with a warning.
* `frameCount` lets you write notes below the frames (the frame size, what each frame is for): the rows past the last frame wanted are ignored. Keep such notes at least one frame tall; a shorter tail is still logged as a partial frame.
* **Several animations can share one sheet.** Put them side by side and give each its own `col` (and `row`): a left pillar at column 1, a right pillar at column 11, an eye at column 21, all in one file. Each animation's next frame is always `height + gap` rows further down.
* A sheet wider than 80 columns needs a SAUCE record that gives its width, as any art does.

#### One art file per frame

A list of art names under `art`, one per frame. A list may name the same file more than once:

```hjson
frames: {
    art: [
        SIGNLIT
        SIGNDIM
        SIGNLIT
        SIGNOUT
    ]
}
```

#### Finding the art

Frame art (a sheet, or a list of files) is found as a menu's own art is: in the user's current theme first, then the default theme, then the module's own `art/` folder (for a menu run by a [mod](../../modding/menu-modules.md)), then the general art directory. A name with a path in it (`mods/my_mod/art/FLAMES`) is read from there. So a theme can replace an animation's frames just by having art of the same name, and a mod can ship its own. See [General Art Information](../general.md).

:::caution
**Do not name frame files after the menu's art plus a number.** Menu art picks a random variant when there are numbered copies of it: art `MAIN` shows `MAIN.ANS`, `MAIN1.ANS` or `MAIN2.ANS` at random. Frame files named `MAIN1.ANS` and `MAIN2.ANS` next to `MAIN.ANS` would sometimes be shown as the whole menu screen. Name them something else (`MAINFX1.ANS`, or a sheet `MAINFX.ANS`). Frame art itself is never picked at random: a frame name always loads that one file.
:::

#### What frames cannot hold

* **MCI codes and format tokens.** A frame is drawn as it was loaded, so `%UN` in frame art or `{BN}` in an inline frame would never be filled in. MCI codes in frame art are drawn blank, with a warning.
* **iCE colours of their own.** Frames write colours only. Whether a bright background shows as bright or as blinking is decided by the menu's art, as it is for every view on the screen; the animation never switches it. If the menu's art does not turn iCE on, keep frames to the 8 normal background colours.

---

### Modes

| Mode | Plays |
|------|-------|
| `loop` | 0, 1, ... last, 0, 1, ... **Default.** |
| `pingpong` | 0, 1, ... last, then back down to 0, and up again. |
| `once` | 0, 1, ... last, then stops on the last frame. With `idle` it goes back to frame 0, rests there for the idle wait, and plays again. |
| `random` | Any frame other than the one showing, each tick. |

### Timing

A frame shows for its `frameDurations` entry if it has one, otherwise for `frameInterval`. No frame is drawn sooner than `menus.animations.minFrameIntervalMs` (default 50 ms) after the one before it, whatever the config asks for; see **Turning Animations Off** below.

### Idle

With `idle`, frame 0 shows for the idle wait instead of its own duration, **every time frame 0 comes round**: the first draw (when the animation starts on frame 0), each lap of `loop`, each return of `pingpong`, each rest of `once`. This is how something can sit still for a few seconds, do a short thing, and sit still again. Frame 0's `frameDurations` entry is not used while `idle` is set.

`idle: 0` (or a `[ min, max ]` whose max is 0) is the same as no idle. `idle` does nothing in `random` mode.

### Transparency

With `transparent: "~"`, a cell that is `~` in every frame is never drawn: the art under the box shows there, and the animation can have a shape other than a rectangle. A cell that is `~` in only some frames cannot show the art (the art is not known to the animation), so in those frames it is drawn as a blank in that cell's colour, and a warning is logged.

---

### Turning Animations Off

* In `config.hjson`, `menus.animations.enabled: false` turns animations off everywhere. A menu cannot turn them back on.
* In a menu's `config` block, `animations: false` turns off that menu's animations only.
* Animations play on ANSI sessions only. On PETSCII, ATASCII and RIP sessions frame 0 is drawn once and nothing moves.

When animations are off each animation view draws frame 0 once (not `startFrame`) and nothing ticks, so the screen still looks finished. Draw frame 0 as the resting state.

These switches also cover [animated focused items](views.md#animated-focused-item) (`focusItemFrames`): with animations off, the focused item shows its `focusItemFormat`, or frame 0.

```hjson
//  config.hjson
menus: {
    animations: {
        //  false: no animation ticks, on any menu
        enabled: true
        //  no frame is drawn sooner than this many ms after the last
        minFrameIntervalMs: 50
    }
}
```

See [Menu HJSON](../../configuration/menu-hjson.md#config-block) for the per-menu `animations` setting.

### When frames do not load

If the frames cannot be loaded (an art file that does not exist, a sheet with no whole frame, a missing `width`), a warning is logged naming the menu and the view, and nothing is drawn in the box: it stays as the art drew it. The rest of the menu loads and works as usual.

### Covers and forms that are not shown

An animation follows the same rules as tickers and status bars: while something covers the screen (a realtime interrupt, a help page, a pause that clears the screen) it draws nothing, and it is drawn again in full when the cover goes. With `pauseWhenInactive: true` it also stops while its form is inactive. See [When something covers the screen](views.md#when-something-covers-the-screen) and [Form states](views.md#form-states).

### Bandwidth

Only the cells that change are sent each tick, but an animation still sends data for as long as the screen is up. Measured on telnet: two 8x9 fire pillars at 120 ms, where most cells change every frame, come to about 6 KB/s; a 5x3 spinner at 90 ms to under 1 KB/s; a glint that plays once every few seconds to almost nothing. That is fine over telnet, SSH and WebSocket, and far too much for a caller on an emulated slow modem. Keep boxes modest and `frameInterval` at 80 ms or more, and use `idle` for things that do not need to move all the time.

---

## Examples

<details>
<summary>Inline spinner, placed by a marker (expand)</summary>

The art holds `%AV20` where the 5x3 box goes. Twelve inline frames move a comet round a ½ sign.

```hjson
AV20: {
    width: 5
    height: 3
    mode: loop
    frameInterval: 90
    frames: [
        "|11|16■|08|16····\n|03|16■|07|16 |14|16½|07|16 |08|16·\n|03|16·|08|16····"
        "|03|16■|11|16■|08|16···\n|03|16·|07|16 |14|16½|07|16 |08|16·\n|08|16·····"
        "|03|16·■|11|16■|08|16··\n|08|16·|07|16 |14|16½|07|16 |08|16·\n|08|16·····"
        "|08|16·|03|16·■|11|16■|08|16·\n|08|16·|07|16 |14|16½|07|16 |08|16·\n|08|16·····"
        "|08|16··|03|16·■|11|16■\n|08|16·|07|16 |14|16½|07|16 |08|16·\n|08|16·····"
        "|08|16···|03|16·■\n|08|16·|07|16 |14|16½|07|16 |11|16■\n|08|16·····"
        "|08|16····|03|16·\n|08|16·|07|16 |14|16½|07|16 |03|16■\n|08|16····|11|16■"
        "|08|16·····\n|08|16·|07|16 |14|16½|07|16 |03|16·\n|08|16···|11|16■|03|16■"
        "|08|16·····\n|08|16·|07|16 |14|16½|07|16 |08|16·\n|08|16··|11|16■|03|16■·"
        "|08|16·····\n|08|16·|07|16 |14|16½|07|16 |08|16·\n|08|16·|11|16■|03|16■·|08|16·"
        "|08|16·····\n|08|16·|07|16 |14|16½|07|16 |08|16·\n|11|16■|03|16■·|08|16··"
        "|08|16·····\n|11|16■|07|16 |14|16½|07|16 |08|16·\n|03|16■·|08|16···"
    ]
}
```

</details>

<details>
<summary>Two fire pillars from one sheet (expand)</summary>

The art holds `%AV20` and `%AV21` where the pillars go. `FLAMES.ANS` has two 8-column flames side by side (the left one at column 1, the right one at column 11), six frames of 9 rows stacked down the file with a blank row between them. `startFrame: 3` keeps the right pillar half a cycle out of step with the left: it shows frame 3 while the left one shows frame 0, and so on.

```hjson
AV20: {
    width: 8
    height: 9
    frames: {
        art: FLAMES
        col: 1
        gap: 1
        frameCount: 6
    }
    mode: loop
    frameInterval: 120
}
AV21: {
    width: 8
    height: 9
    frames: {
        art: FLAMES
        col: 11
        gap: 1
        frameCount: 6
    }
    mode: loop
    frameInterval: 120
    //  half a cycle out of step with the left one
    startFrame: 3
}
```

</details>

<details>
<summary>An eye that glints now and then, with no marker (expand)</summary>

The menu's art is a skull, with no marker in it: `position` puts an 8x5 box over the skull's right eye socket. Frame 0 of `EYEGLINT.ANS` is a copy of the art under the box (a block copy in your art editor), so the art looks untouched while the eye rests. It rests for 3 to 8 seconds, plays glow, flare, glow once, and rests again. The sheet has a few lines of notes below its four frames, which `frameCount` leaves out.

```hjson
AV20: {
    position: {
        row: 9
        col: 23
    }
    width: 8
    height: 5
    frames: {
        art: EYEGLINT
        //  the sheet has notes under its 4 frames
        frameCount: 4
    }
    mode: once
    idle: [ 3000, 8000 ]
    //  frame 0's entry is not used: idle replaces it
    frameDurations: [ 0, 120, 300, 150 ]
}
```

</details>
