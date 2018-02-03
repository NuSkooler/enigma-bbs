---
layout: page
title: Configuring a Message Area
---
**Message Conferences** and **Areas** allow for grouping of message base topics.

## Message Conferences
Message Conferences are the top level container for 1:n Message Areas via the `messageConferences` section 
in `config.hjson`. Common message conferences may include a local conference and one or more conferences 
each dedicated to a particular message network such as FsxNet, AgoraNet, etc.

Each conference is represented by a entry under `messageConferences`. **The areas key is the conferences tag**.

| Config Item | Required | Description                                                                     |
|-------------|----------|---------------------------------------------------------------------------------|
| `name`      | :+1:     | Friendly conference name                                                        |
| `desc`      | :+1:     | Friendly conference description                                                 |
| `sort`      | :-1:     | If supplied, provides a key used for sorting                                    |
| `default`   | :-1:     | Specify `true` to make this the default conference (e.g. assigned to new users) |
| `areas`     | :+1:     | Container of 1:n areas described below                                          |

### Example

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
Message Areas are topic specific containers for messages that live within a particular conference. #
**The area's key is its area tag**. For example, "General Discussion" may live under a Local conference 
while an AgoraNet conference may contain "BBS Discussion".

| Config Item | Required | Description                                                                     |
|-------------|----------|---------------------------------------------------------------------------------|
| `name`      | :+1:     | Friendly area name                                                              |
| `desc`      | :+1:     | Friendly area discription                                                       |
| `sort`      | :-1:     | If supplied, provides a key used for sorting                                    |
| `default`   | :-1:     | Specify `true` to make this the default area (e.g. assigned to new users)       |

### Example

```hjson
messageConferences: {
  local: {
    // ... see above ...
    areas: {
      enigma_dev: {                     // Area tag - required elsewhere!
        name: ENiGMA 1/2 Development   
        desc: ENiGMA 1/2 discussion!   
        sort: 1                        
        default: true                   
      }
    }
  }
}
```