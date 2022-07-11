---
layout: page
title: Node to Node Messaging
---
## The Node to Node Messaging Module
The node to node messaging (`node_msg`) module allows users to send messages to one or more users on different nodes. Messages delivered to nodes follow standard [User Interruption](../misc/user-interrupt.md) rules.

## Configuration
### Config Block
Available `config` block entries:
* `dateTimeFormat`: [moment.js](https://momentjs.com) style format. Defaults to current theme → system `short` format.
* `messageFormat`: Format string for sent messages. Defaults to `Message from {fromUserName} on node {fromNodeId}:\r\n{message}`. The following format object members are available:
    * `fromUserName`: Username who sent the message.
    * `fromRealName`: Real name of user who sent the message.
    * `fromNodeId`: Node ID where the message was sent from.
    * `message`: User entered message. May contain pipe color codes.
    * `timestamp`: A timestamp formatted using `dateTimeFormat` above.
* `art`: Block containing:
    * `header`: Art spec for header to display with message.
    * `footer`: Art spec for footer to display with message.

## Theming
### MCI Codes
1. Node selection. Must be a View that allows lists such as `SpinnerMenuView` (`%SM1`), `HorizontalMenuView` (`%HM1`), etc.
2. Message entry (`%ET2`).
3. Message preview (`%TL3`). A rendered (that is, pipe codes resolved) preview of the text in `%ET2`.

10+: Custom using `itemFormat`. See below.

### Item Format
The following `itemFormat` object is provided for MCI 1 and 10+ for the currently selected item/node:
* `text`: Node ID or "-ALL-" (All nodes).
* `node`: Node ID or `-1` in the case of all nodes.
* `userId`: User ID.
* `action`: User's action.
* `userName`: Username.
* `realName`: Real name.
* `location`: User's location.
* `affils`: Affiliations.
* `timeOn`: How long the user has been online (approx).

