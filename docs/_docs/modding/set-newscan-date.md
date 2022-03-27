---
layout: page
title: Set Newscan Date Module
---
## Set Newscan Date Module
The `set_newscan_date` module allows setting newscan dates (aka pointers) for message conferences and areas as well as within the file base. Users can select specific conferences/areas or all (where applicable).

## Configuration
### Configuration Block
Available `config` block entries are as follows:
* `target`: Choose from `message` for message conferences & areas, or `file` for file base areas.
* `scanDateFormat`: Format for scan date. This format must align with the **output** of the MaskEditView (`%ME1`) MCI utilized for input. Defaults to `YYYYMMDD` (which matches mask of `####/##/##`).

### Theming
#### Message Conference & Areas
When `target` is `message`, the following `itemFormat` object is provided to MCI 2 (ie: `%SM2`):
* `conf`: An object containing:
    * `confTag`: Conference tag.
    * `name`: Conference name. Also available in `{text}`.
    * `desc`: Conference description.
* `area`: An object containing:
    * `areaTag`: Area tag.
    * `name`: Area name. Also available in `{text}`.
    * `desc`: Area description.

When dealing with the file base, ENiGMA½ does not currently have the ability to set newscan dates for specific areas. No `%SM2` is used in this case.

### Submit Actions
Submit action should map to `@method:scanDateSubmit` and provide `scanDate` in form data. For message conf/areas (`target` of `message`), `targetSelection` should be also be provided in form data: An index to the selected conf/area.
