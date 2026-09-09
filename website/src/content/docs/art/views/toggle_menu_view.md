---
title: Toggle Menu View
description: "%TM — a two-item toggle for Yes/No and On/Off choices."
sidebar:
    order: 21
---
A toggle menu view displays exactly two items side by side and lets the user flip between them — typically Yes/No or On/Off. It behaves like a [Horizontal Menu View](horizontal_menu_view.md) constrained to two entries.

:::note
A toggle menu view is defined with a percent (%) and the characters TM, followed by the view
number if used. For example: `%TM1`
:::

:::note
See [Views](views.md) for the **common view properties**, the **common menu view
properties**, and the shared **Hot Keys** and **Items** reference — all of which
apply here.
:::

## Properties

A toggle menu view expects **exactly two items**. The first is treated as the
true/yes value and the second as false/no, which is what lets a form read the
view as a boolean.

## Example

![Example](../../assets/images/toggle_menu_view_example1.gif "Toggle menu")

<details>
<summary>Configuration fragment (expand to view)</summary>

```hjson
TM2: {
  focus: true
  submit: true
  argName: navSelect
  focusTextStyle: upper
  items: [ "yes", "no" ]
}
```

</details>
