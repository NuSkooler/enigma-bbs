---
layout: page
title: Ticker View
---
## Ticker View
A ticker view displays text as a continuously animated marquee inside a fixed-width window. It supports multiple independent motion styles and visual effects that can be freely combined.

## General Information

> :information_source: A ticker view is defined with a percent (%) and the characters TK, followed by the view number. For example: `%TK1`

> :information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

The ticker starts automatically when the screen loads and runs until the screen is torn down. Standard and focus SGR colors are set by placing duplicate MCI codes back-to-back in the art file.

### Properties

| Property | Description |
|----------|-------------|
| `text` | The text to display. Supports pipe color codes and predefined MCI format codes (e.g. `{BN}`, `{CT}`). |
| `width` | Width of the visible ticker window in columns. |
| `motion` | How the text moves. See **Motion Styles** below. Default: `left`. |
| `effect` | Visual effect applied to the text each tick. See **Effects** below. Default: `normal`. |
| `tickInterval` | Milliseconds between animation steps (default: `100`). Lower = faster. |
| `holdTicks` | For `reveal`, `typewriter`, and `fallLeft`/`fallRight` motions: ticks to hold at full display before cycling (default: `20`). |
| `fillChar` | Character used to fill empty space in the window (default: space). |

---

### Motion Styles

Controls how the text moves within the window. Set via the `motion` property.

| Motion | Description |
|--------|-------------|
| `left` | Continuous left-scroll that loops with a gap. **Default.** |
| `right` | Continuous right-scroll that loops with a gap. |
| `bounce` | Text oscillates left and right, reversing direction at each end. No gap between loops. |
| `reveal` | Text slides in from the right, holds for `holdTicks`, then slides back out. Repeats. |
| `typewriter` | Characters appear one per tick from left-to-right, hold at full display for `holdTicks`, then instantly clear and repeat. |
| `fallLeft` | All characters start spread evenly across the window then slide left, stacking against the left edge. Holds for `holdTicks`, then re-spreads and repeats. |
| `fallRight` | Same as `fallLeft` but characters slide right and stack against the right edge. |

---

### Effects

Controls the visual appearance of the text. Set via the `effect` property.

#### Text-Style Effects
These apply a character-level transformation to the text at `setText` time. The transformation is permanent per-tick (no per-frame overhead).

| Effect | Example |
|--------|---------|
| `normal` | Text as-is. **Default.** |
| `upper` | ALL CAPS |
| `lower` | all lowercase |
| `title` | Title Case |
| `firstLower` | fIRST lETTER lOWERCASED |
| `smallVowels` | sMALL vOwElS |
| `bigVowels` | bIG vOwEls |
| `smallI` | smAll I — every "i" is lowercase |
| `mixed` | rAnDoM cAsE (re-randomized each `setText` call) |
| `l33t` | l337 5p34k |

#### Dynamic Effects
These are applied per-tick to the visible window, producing animated color or noise.

| Effect | Description |
|--------|-------------|
| `rainbow` | Each character cycles through 6 bright ANSI colors. The color band swims through the text with the scroll, producing a flowing neon look. |
| `scramble` | About 30% of non-space characters are replaced with random noise characters rendered in bright green each tick, giving a decryption/hacker feel. |
| `glitch` | Real text with 1–3 random characters corrupted to red noise per tick. Looks like signal interference. |

> :bulb: Text-style effects and dynamic effects are independent axes — `l33t` + `rainbow` works: the text is l33t-ified first, then rainbow colors are applied to the visible window each tick.

---

## Examples

<details>
<summary>Scrolling board name with rainbow effect (expand)</summary>
<div markdown="1">

```hjson
TK1: {
  text: "Welcome to {BN} -- {VN}   "
  width: 60
  motion: left
  effect: rainbow
  tickInterval: 80
}
```
</div>
</details>

<details>
<summary>Bouncing l33t ticker (expand)</summary>
<div markdown="1">

```hjson
TK1: {
  text: "ENiGMA BBS - the future is now"
  width: 50
  motion: bounce
  effect: l33t
  tickInterval: 60
}
```
</div>
</details>

<details>
<summary>Typewriter reveal with glitch effect (expand)</summary>
<div markdown="1">

```hjson
TK1: {
  text: "SYSTEM ONLINE"
  width: 40
  motion: typewriter
  effect: glitch
  tickInterval: 100
  holdTicks: 30
}
```
</div>
</details>

<details>
<summary>Slide-in reveal (expand)</summary>
<div markdown="1">

```hjson
TK1: {
  text: "Welcome back, {UN}"
  width: 40
  motion: reveal
  effect: normal
  tickInterval: 60
  holdTicks: 25
}
```
</div>
</details>
