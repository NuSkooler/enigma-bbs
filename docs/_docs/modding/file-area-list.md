---
layout: page
title: File Area List
---
## The File Area List Module
The built in `file_area_list` module provides a very flexible file listing UI.

## Configuration
### Config Block
Available `config` block entries:
* `art`: Sub-configuration block used to establish art files used for file browsing:
    * `browse`: The main browse screen.
    * `details`: The main file details screen.
    * `detailsGeneral`: The "general" tab of the details page.
    * `detailsNfo`: The "NFO" viewer tab of the detials page.
    * `detailsFileList`: The file listing tab of the details page (ie: used for listing archive contents).
    * `help`: The help page.
* `hashTagsSep`: Separator for hash entries. Defaults to ", ".
* `isQueuedIndicator`: Indicator for items that are in the users download queue. Defaults to "Y".
* `isNotQueuedIndicator`: Indicator for items that are _not_ in the users download queue. Defaults to "N".
* `userRatingTicked`: Indicator for a items current _n_/5 "star" rating. Defaults to "\*". `userRatingTicked` and `userRatingUnticked` are combined to build strings such as "***--" for 3/5 rating.
* `userRatingUnticked`: Indicator for missing "stars" in a items _n_/5 rating. Defaults to "-". `userRatingTicked` and `userRatingUnticked` are combined to build strings such as "***--" for 3/5 rating.
* `webDlExpireTimeFormat`: Presents the expiration time of a web download URL. Defaults to current theme → system `short` date/time format.
* `webDlLinkNeedsGenerated`: Text to present when no web download link is yet generated. Defaults to "Not yet generated".
* `webDlLinkNoWebserver`: Text to present when no web download is available (ie: webserver not enabled). Defaults to "Web server is not enabled".
* `notAnArchiveFormat`: Presents text for the "archive type" field for non-archives. Defaults to "Not an archive".
* `uploadTimestampFormat`: Timestamp format for `xxxxxxInfoFormat##`. Defaults to current theme → system `short` date format. See also **Custom Info Formats** below.

Remember that entries such as `isQueuedIndicator` and `userRatingTicked` may contain pipe color codes!

## Custom Info Formats
Additional `config` block entries can set `xxxxxxInfoFormat##` formatting (where xxxxxx is the page name and ## is 10...99 such as `browseInfoFormat10`) for the various available pages:
* `browseInfoFormat##` for the `browse` page. See **Browse Page** below.
* `detailsInfoFormat##` for the `details` page. See **Details Page** below.
* `detailsGeneralInfoFormat##` for the `detailsGeneral` tab. See **Details Page - General Tab** below.
* `detailsNfoInfoFormat##` for the `detialsNfo` tab. See **Details Page - NFO/README Viewer Tab** below.
* `detailsFileListInfoFormat##` for the `detailsFileList` tab. See **Details Page - Archive/File Listing Tab** below.

## Theming
### Browse Page
The browse page uses the `browse` art described above. The following MCI codes are available:
* MCI 1 (ie: `%MT1`): File's short description (user entered, FILE_ID.DIZ, etc.).
* MCI 2 (ie: `%HM2`): Navigation menu.
* MCI 10...99: Custom entires with the following format members:
    * `{fileId}`: File identifier.
    * `{fileName}`: File name (long).
    * `{desc}`: File short description (user entered, FILE_ID.DIZ, etc.).
    * `{descLong}`: File's long description (README.TXT, SOMEGROUP.NFO, etc.).
    * `{uploadByUserName}`: User name of user that uploaded this file, or "N/A".
    * `{uploadByUserId}`: User ID of user that uploaded this file, or "N/A".
    * `{userRating}`: User rating of file as a number.
    * `{userRatingString}`: User rating of this file as a string formatted with `userRatingTicked` and `userRatingUnticked` described above.
    * `{areaTag}`: Area tag.
    * `{areaName}`: Area name or "N/A".
    * `{areaDesc}`: Area description or "N/A".
    * `{fileSha256}`: File's SHA-256 value in hex.
    * `{fileMd5}`: File's MD5 value in hex.
    * `{fileSha1}`: File's SHA1 value in hex.
    * `{fileCrc32}`: File's CRC-32 value in hex.
    * `{estReleaseYear}`: Estimated release year of this file.
    * `{dlCount}`: Number of times this file has been downloaded.
    * `{byteSize}`: Size of this file in bytes.
    * `{archiveType}`: Archive type of this file determined by system mappings, or "N/A".
    * `{archiveTypeDesc}`: A more descriptive archive type based on system mappings, file extention, etc. or "N/A" if it cannot be determined.
    * `{shortFileName}`: Short DOS style 8.3 name available for some scenarios such as TIC import, or "N/A".
    * `{ticOrigin}`: Origin from TIC imported files "Origin" field, or "N/A".
    * `{ticDesc}`: Description from TIC imported files "Desc" field, or "N/A".
    * `{ticLDesc}`: Long description from TIC imported files "LDesc" field joined by a line feed, or "N/A".
    * `{uploadTimestamp}`: Upload timestamp formatted with `browseUploadTimestampFormat`.
    * `{hashTags}`: A string of hash tags(s) separated by `hashTagsSep` described above. "(none)" if there are no tags.
    * `{isQueued}`: Indicates if a item is currently in the user's download queue presented as `isQueuedIndicator` or `isNotQueuedIndicator` described above.
    * `{webDlLink}`: Web download link if generated else `webDlLinkNeedsGenerated` or `webDlLinkNoWebserver` described above.
    * `{webDlExpire}`: Web download link expiration using `webDlExpireTimeFormat` described above.

### Details Page
The details page uses the `details` art described above. The following MCI codes are available:
* MCI 1 (ie: `%HM1`): Navigation menu
* `%XY2`: Info area's top X,Y position.
* `%XY3`: Info area's bottom X,Y position.
* MCI 10...99: Custom entries with the format options described above in **Browse Page** via the `detailsInfoFormat##` `config` block entry.

### Details Page - General Tab
The details page general tab uses the `detailsGeneral` art described above. The following MCI codes are available:
* MCI 10...99: Custom entries with the format options described above in **Browse Page** via the `detailsGeneralInfoFormat##` `config` block entry.

### Details Page - NFO/README Viewer Tab
The details page nfo tab uses the `detailsNfo` art described above. The following MCI codes are available:
* MCI 1 (ie: `%MT1`): NFO/README viewer using the entries `longDesc`.
* MCI 10...99: Custom entries with the format options described above in **Browse Page** via the `detailsNfoInfoFormat##` `config` block entry.

### Details Page - Archive/File Listing Tab
The details page file list tab uses the `detailsFileList` art described above. The following MCI codes are available:
* MCI 1 (ie: `%VM1`): List of entries in archive. Entries are formatted using the standard `itemFormat` and `focusItemFormat` properties of the view and have all of the format options described above in **Browse Page**.
* MCI 10...99: Custom entries with the format options described above in **Browse Page** via the `detailsFileListInfoFormat##` `config` block entry.

