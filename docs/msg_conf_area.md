# Message Conferences & Areas
**Message Conferences** and **Areas** allow for grouping of message base topics.

## Message Conferences
Message Conferences are the top level container for 1:n Message Areas via the `messageConferences` section in `config.hjson`. Common message conferences may include a local conference and one or more conferences each dedicated to a particular message network such as FidoNet, AgoraNet, etc.

Each conference is represented by a entry under `messageConferences`. **The areas key is the conferences tag**.

**Members**:
* `name` (required): Friendly conference name
* `desc` (required): Friendly conference description
* `sort` (optional): If supplied, provides a key used for sorting
* `default` (optional): Specify `true` to make this the default conference (e.g. assigned to new users)
* `areas`: Container of 1:n areas described below

**Example**:
```hjson
{
  messageConferences: {
    local: {
      name: Local
      desc: Local discussion
      sort: 1
      default: true
    }
  }
}
```

## Message Areas
Message Areas are topic specific containers for messages that live within a particular conference. **The areas key is it's areas tag**. For example, "General Discussion" may live under a Local conference while an AgoraNet conference may contain "BBS Discussion".

**Members**:
* `name` (required): Friendly area name
* `desc` (required): Friendly area discription
* `sort` (optional): If supplied, provides a key used for sorting
* `default` (optional): Specify `true` to make this the default area (e.g. assigned to new users)

**Example**:
```hjson
messageConferences: {
  local: {
    // ... see above ...
    areas: {
      local_enigma_dev: {
        name: ENiGMA 1/2 Development
        desc: Discussion related to features and development of ENiGMA 1/2!
        sort: 1
        default: true
      }
    }
  }
}
```

## Message Networks
ENiGMA½ has the ability to network with other systems via [Message Networks](msg_networks.md). Message **area tags** (described above) are utilized to map foreign areas with locally defined areas.