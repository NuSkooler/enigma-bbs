---
layout: page
title: ActivityPub Message Browser
---
## The ActivityPub Message Browser Module
The built-in `activity_pub_msg_list` module provides a scrollable, paginated list of messages (Notes) received from the Fediverse. It supports multiple view modes, lazy-loading of additional pages as the user scrolls, and navigation to a message viewer or thread view.

> :information_source: ActivityPub must be enabled and the [ActivityPub Web Handler](../servers/contentservers/activitypub-handler.md) must be configured for messages to appear.

## View Modes
The browser can be opened in one of the following modes by passing `mode` via `extraArgs`:

| Mode | `extraArgs.mode` | Description |
|------|-----------------|-------------|
| Federated | `federated` | All Notes received in the shared inbox. **(default)** |
| Local | `local` | Notes sent by users on this system. |
| Timeline | `timeline` | Notes from a specific actor. Requires `extraArgs.actorId`. |
| Mentions | `mentions` | Notes that mention the current user. |
| Thread | `thread` | All Notes in a single thread/context. Requires `extraArgs.contextId`. |

**Example** — launching the browser in Mentions mode from a menu action:
```hjson
{
    action: @menu:activityPubMsgBrowser
    extraArgs: {
        mode: mentions
    }
}
```

## Config Block
| Key | Required | Description |
|-----|----------|-------------|
| `art.main` | :+1: | Art spec for the main browser screen. |
| `dateTimeFormat` | :-1: | [moment.js](https://momentjs.com/docs/#/displaying/format/) format string for message timestamps. `am`/`pm` are collapsed to `a`/`p`. Defaults to `MM/DD hh:mma` (12-char output). |
| `attIndicator` | :-1: | Single character shown in the attachment column. Defaults to `*`. |
| `likeIndicator` | :-1: | Single character shown as the like indicator in TL10+ views. Defaults to `♥` (CP437 `0x03`). |
| `boostIndicator` | :-1: | Single character shown as the boost indicator in TL10+ views. Defaults to `▲` (CP437 `0x1E`). |
| `viewerMenu` | :-1: | Menu name to push when opening a message. Defaults to `activityPubMsgViewer`. |
| `threadMenu` | :-1: | Menu name to push when opening a thread. Defaults to `actPubThread`. |

**Example**:
```hjson
activityPubMsgBrowser: {
    desc: ActivityPub Message Browser
    module: ./activitypub/activity_pub_msg_list
    config: {
        art: {
            main: activitypub_msg_browser
        }
        dateTimeFormat: "MM/DD hh:mma"
        attIndicator: "@"
    }
    // ...
}
```

## Theming

### MCI 1 — `%VM1` Message List
Each row in the list provides the following `itemFormat` / `focusItemFormat` fields:

| Field | Description |
|-------|-------------|
| `from` | Sender handle in `@user@host` form. Full length, truncate with `{from:<16.16}`. |
| `subject` | Message subject/summary. Prefixed with `[CW] ` for content-warned posts, `re: ` for replies. |
| `date` | Formatted timestamp string (see `dateTimeFormat`). |
| `likes` | Like count as a string; empty string when zero (blank-if-zero in right-justified formats). |
| `boosts` | Boost count as a string; empty string when zero. |
| `att` | Attachment indicator character, or a space when no attachment. |
| `hasAttachment` | Boolean `true`/`false`. |
| `noteId` | Internal ActivityPub Note ID (URL). |
| `contextId` | Thread context/conversation ID, if present. |
| `inReplyTo` | ID of the parent Note, if this is a reply. |
| `text` | Pre-built fallback display string (fixed 71-char layout). Used when `itemFormat` is not set in the theme. |

**Example** `itemFormat` in `theme.hjson`:
```hjson
activityPubMsgBrowser: {
    0: {
        mci: {
            VM1: {
                itemFormat:      "|00|07{from:<16.16} {subject:<33.33} {date:<12.12} {likes:>2} {boosts:>2} {att}"
                focusItemFormat: "|00|15{from:<16.16} {subject:<33.33} {date:<12.12} {likes:>2} {boosts:>2} {att}"
            }
        }
    }
}
```

### MCI 10+ — Custom Views
`%TL10`, `%TL11`, etc. may be placed in the art and configured in the menu's `config` block using `infoFormat##` keys (e.g. `infoFormat10`). The following properties are available:

| Property | Description |
|----------|-------------|
| `modeLabel` | Current mode name: `Federated`, `Local`, `Timeline`, `Mentions`, or `Thread`. |
| `msgCount` | Current number of loaded messages (as a string). |
| `attIndicator` | Configured attachment indicator character. |
| `likeIndicator` | Configured like indicator character. |
| `boostIndicator` | Configured boost indicator character. |

**Example**:
```hjson
activityPubMsgBrowser: {
    config: {
        infoFormat10: "{modeLabel} ({msgCount} messages)"
    }
}
```

## Action Keys
The following keys are handled by the `listKeyPressed` menu method, which should be assigned via `actionKeys` in form `0`:

| Key(s) | Action |
|--------|--------|
| `return`, `space` | Open the selected message in the viewer. |
| `b` | Boost (announce) the selected message. |
| `l` | Like the selected message. |
| `r` | Reply to the selected message. |
| `t`, `+` | Open the thread containing the selected message. |
| `down arrow` | Move focus to the next message. |
| `up arrow` | Move focus to the previous message. |
| `page down` | Scroll list down one page. |
| `page up` | Scroll list up one page. |

**Menu config example**:
```hjson
activityPubMsgBrowser: {
    form: {
        0: {
            mci: {
                VM1: {
                    focus: true
                }
            }
            actionKeys: [
                {
                    keys: ["return", "space", "b", "l", "r", "t", "+", "down arrow", "up arrow", "page up", "page down"]
                    action: @method:listKeyPressed
                }
                {
                    keys: ["escape", "q", "shift + q"]
                    action: @systemMethod:prevMenu
                }
            ]
        }
    }
}
```

## Lazy Loading
The browser fetches messages in pages of 25. When the focused row comes within 5 entries of the end of the loaded list, the next page is automatically fetched and appended — no user action is required.

Thread mode (`mode: thread`) loads all messages in the thread at once and does not paginate.
