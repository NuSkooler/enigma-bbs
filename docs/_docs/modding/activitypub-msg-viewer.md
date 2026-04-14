---
layout: page
title: ActivityPub Message Viewer
---
## The ActivityPub Message Viewer Module
The built-in `activity_pub_msg_viewer` module provides a read-only, scrollable viewer for individual ActivityPub Notes from the Fediverse. It uses a two-art layout — a body art containing the message text and header labels, and a footer art containing a horizontal action menu — mirroring the FSE view-mode design.

> :information_source: This module is normally pushed by the [ActivityPub Message Browser](./activitypub-msg-browser.md) and receives the selected message via `extraArgs`. It can also be launched directly from a menu if needed.

## Layout
Two separate art files are used:

| Art key | Form ID | Contents |
|---------|---------|----------|
| `art.body` | 1 | Message body (`%MT1`) and header label views (`%TL10`+). |
| `art.footer` | 4 | Single-row action menu (`%HM1`). |

The body occupies the top portion of the screen; the footer is drawn immediately below it.

## Focus Model
The footer (`%HM1`) is **always focused** — this matches FSE view mode. The body form (form 1) exists only to hold `%MT1` and the `%TL10+` label views; it is never directly focused and accepts no input.

All user interaction — including scrolling the message body — is handled by action keys and the HM1 menu in form 4.

## Config Block
| Key | Required | Description |
|-----|----------|-------------|
| `art.body` | :+1: | Art spec for the body screen (contains `%MT1` and `%TL10`+). |
| `art.footer` | :+1: | Art spec for the footer screen (contains `%HM1`). |
| `dateTimeFormat` | :-1: | [moment.js](https://momentjs.com/docs/#/displaying/format/) format string for the message date. `am`/`pm` are collapsed to `a`/`p`. Defaults to `MM/DD hh:mma`. |

**Example**:
```hjson
activityPubMsgViewer: {
    desc: ActivityPub Message Viewer
    module: ./activitypub/activity_pub_msg_viewer
    config: {
        art: {
            body:   activitypub_msg_viewer
            footer: activitypub_msg_viewer_footer
        }
    }
    // ...
}
```

## Theming

### MCI 1 — `%MT1` Message Body (Form 1)
A multi-line text view displaying the decoded Note content. Should be configured in `preview` mode with `acceptsFocus: false` and `acceptsInput: false`. `width` and `height` must be set explicitly in the theme to match the art layout — the view system does not derive dimensions from art for `MT` type views.

**Example** in `theme.hjson`:
```hjson
activityPubMsgViewer: {
    1: {
        mci: {
            MT1: {
                mode: preview
                width: 78
                height: 17
            }
        }
    }
}
```

> :warning: If `width` or `height` are omitted, `%MT1` will render as an empty area. Set them to match the usable space in your body art file.

### MCI 10+ — Custom Header Views (Form 1)
`%TL10`, `%TL11`, etc. may be placed anywhere in the body art and configured via `bodyInfoFormat##` keys in the menu's `config` block:

| Property | Description |
|----------|-------------|
| `from` | Sender handle in `@user@host` form. |
| `subject` | Message subject/summary. Prefixed with `[CW] ` for content-warned posts, `re: ` for replies. |
| `date` | Formatted timestamp string (see `dateTimeFormat`). |
| `likes` | Like count as a string; empty when zero. |
| `boosts` | Boost count as a string; empty when zero. |
| `att` | Attachment indicator character, or a space when no attachment. |
| `hasAtt` | `'1'` if the Note has attachments, otherwise `''`. |
| `threadPos` | Position of this Note within its thread (e.g. `'3'`), or `''` if unknown. |
| `threadTotal` | Total number of Notes in the thread, or `''` if unknown. |
| `threadInfo` | Formatted thread position string (e.g. `'3 of 7'`), or `''` if unknown. |
| `hasPrev` | `'1'` if the Note is a reply (has a parent), otherwise `''`. |
| `hasNext` | `'1'` if a next Note exists in the thread, otherwise `''`. |
| `modeLabel` | Source mode label passed from the browser: `Federated`, `Local`, `Timeline`, `Mentions`, or `Thread`. |
| `likeIndicator` | Like indicator character (CP437 ♥ by default; configurable via `likeIndicator` in config). |
| `boostIndicator` | Boost indicator character (CP437 ▲ by default; configurable via `boostIndicator` in config). |

**Example** config:
```hjson
activityPubMsgViewer: {
    config: {
        bodyInfoFormat10: "{modeLabel}"
        bodyInfoFormat11: "{from:<40.40}"
        bodyInfoFormat12: "{subject:<40.40}"
        bodyInfoFormat13: "{date:<14.14}"
        bodyInfoFormat14: "{threadInfo}"
    }
}
```

### MCI 1 — `%HM1` Footer Action Menu (Form 4)
A horizontal menu with the following items (by index):

| Index | Default label | Action |
|-------|--------------|--------|
| 0 | `prev` | Navigate to the previous message in the browser list. |
| 1 | `next` | Navigate to the next message in the browser list. |
| 2 | `next thd` | Navigate to the next Note in the thread context (`]`). |
| 3 | `prev thd` | Navigate to the parent Note via `inReplyTo` (`[`). |
| 4 | `boost` | Boost (announce) the current Note. |
| 5 | `like` | Like the current Note. |
| 6 | `reply` | Reply to the current Note. |
| 7 | `quit` | Exit the viewer and return to the browser. |

Items are plain strings; focus appearance is controlled by the art file or `focusTextStyle` in the `HM1` MCI config. Place `%HM1^[[...m%HM1` (two codes with a focus SGR between them) in the art to give the focused item a distinct style.

## Default Action Keys
These may be changed in your board's `menu.hjson`. All keys are handled by the **footer** form (form 4) — the footer is always focused.

| Key(s) | Action |
|--------|--------|
| `up arrow` | Scroll message body up one line. |
| `down arrow` | Scroll message body down one line. |
| `page up` | Scroll message body up one page. |
| `page down` | Scroll message body down one page. |
| `[` | Navigate to the parent Note via `inReplyTo` (thread nav). |
| `]` | Navigate to the next Note in the thread context. |
| `b` | Boost the current Note. |
| `l` | Like the current Note. |
| `r` | Reply to the current Note. |
| `q`, `Q`, `escape` | Quit and return to the browser. |

**Menu config example**:
```hjson
activityPubMsgViewer: {
    form: {
        1: {
            mci: {
                MT1: {
                    mode: preview
                    acceptsFocus: false
                    acceptsInput: false
                }
            }
        }
        4: {
            mci: {
                HM1: {
                    items: ["prev", "next", "next thd", "prev thd", "boost", "like", "reply", "quit"]
                    focusItemIndex: 1
                    submit: true
                }
            }
            submit: {
                *: [
                    { value: { 1: 0 }  action: @method:prevNote }
                    { value: { 1: 1 }  action: @method:nextNote }
                    { value: { 1: 2 }  action: @method:threadNext }
                    { value: { 1: 3 }  action: @method:threadPrev }
                    { value: { 1: 4 }  action: @method:boostNote }
                    { value: { 1: 5 }  action: @method:likeNote }
                    { value: { 1: 6 }  action: @method:replyNote }
                    { value: { 1: 7 }  action: @method:quitViewer }
                ]
            }
            actionKeys: [
                {
                    keys: ["up arrow", "down arrow", "page up", "page down"]
                    action: @method:movementKeyPressed
                }
                {
                    keys: ["["]
                    action: @method:threadPrev
                }
                {
                    keys: ["]"]
                    action: @method:threadNext
                }
                {
                    keys: ["b"]
                    action: @method:boostNote
                }
                {
                    keys: ["l"]
                    action: @method:likeNote
                }
                {
                    keys: ["r"]
                    action: @method:replyNote
                }
                {
                    keys: ["escape", "q", "shift + q"]
                    action: @method:quitViewer
                }
            ]
        }
    }
}
```

## Navigation

**List navigation** (`prev`/`next` menu items, Enter): walks backwards and forwards through the message list that was open in the browser when the viewer was launched. This is the primary navigation mechanism.

**Thread navigation** (`[` / `]`): `[` follows the `inReplyTo` link to the parent Note; `]` loads the thread context and advances to the next Note within it. These are available regardless of how the viewer was opened, but only work when the Note has `inReplyTo` or `context`/`conversation` fields set.
