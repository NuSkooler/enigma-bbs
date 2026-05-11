'use strict';

const {
    jsonResponse,
    problemDetail,
    applyCorsHeaders,
    encodeCursor,
    decodeCursor,
    paginationMeta,
    API_BASE,
} = require('../util');
const { resolveAuthenticatedUser, requireAuth } = require('../auth');

const {
    getAvailableFileAreas,
    getFileAreaByTag,
    getAreaDefaultStorageDirectory,
    scanFile,
    isInternalArea,
} = require('../../file_base_area');

const FileEntry = require('../../file_entry');
const ACS = require('../../acs');
const Config = require('../../config').get;
const User = require('../../user');
const StatLog = require('../../stat_log');
const UserProps = require('../../user_property');
const SysProps = require('../../system_property');

const { stripAnsiControlCodes } = require('../../string_util');
const fs = require('graceful-fs');
const paths = require('path');
const mimeTypes = require('mime-types');
const crypto = require('crypto');
const moment = require('moment');
const _ = require('lodash');

const ROUTE_BASE = `${API_BASE}/files`;
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 512; // 512 MiB

exports.register = function register(webServer, log) {
    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/areas(?:[?#]|$)`),
        handler: (req, resp) => _areasHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/areas/([^/]+)(?:[?#]|$)`),
        handler: (req, resp) => _areaDetailHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/areas/([^/]+)/files(?:[?#]|$)`),
        handler: (req, resp) => _fileListHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'POST',
        path: new RegExp(`^${ROUTE_BASE}/areas/([^/]+)(?:[?#]|$)`),
        handler: (req, resp) => _uploadHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/(\\d+)(?:[?#]|$)`),
        handler: (req, resp) => _fileMetaHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/(\\d+)/download(?:[?#]|$)`),
        handler: (req, resp) => _downloadHandler(req, resp, log),
    });
};

function _acsForUser(user) {
    return new ACS({ user });
}

function _isAreaPublic(areaTag) {
    const config = Config();
    const publicAccess = config.contentServers?.web?.restApi?.files?.publicAccess || {};
    const rule = publicAccess[areaTag];
    if (!rule) {
        return false;
    }
    const included = _matchesGlob(areaTag, rule.include || []);
    const excluded = _matchesGlob(areaTag, rule.exclude || []);
    return included && !excluded;
}

function _matchesGlob(tag, patterns) {
    return patterns.some(p => {
        if (p === '*') {
            return true;
        }
        if (p.endsWith('*')) {
            return tag.startsWith(p.slice(0, -1));
        }
        return tag === p;
    });
}

//  Resolve auth and check area read access. Writes error response and returns
//  without calling cb on failure.
function _resolveAreaReadAccess(req, resp, areaTag, cb) {
    if (isInternalArea(areaTag)) {
        return problemDetail(
            resp,
            403,
            'Forbidden',
            'This area is not accessible via the REST API'
        );
    }

    const area = getFileAreaByTag(areaTag);
    if (!area) {
        return problemDetail(resp, 404, 'Not Found', `Area '${areaTag}' not found`);
    }

    resolveAuthenticatedUser(req, (err, authedUser) => {
        if (authedUser) {
            User.getUser(authedUser.userId, (err, user) => {
                if (err || !user) {
                    return problemDetail(resp, 401, 'Authentication Required');
                }
                const acs = _acsForUser(user);
                if (!acs.hasFileAreaRead(area)) {
                    return problemDetail(
                        resp,
                        403,
                        'Forbidden',
                        'Insufficient access to this area'
                    );
                }
                return cb(user, area);
            });
        } else {
            if (!_isAreaPublic(areaTag)) {
                return problemDetail(resp, 401, 'Authentication Required');
            }
            return cb(null, area);
        }
    });
}

function _shouldStripAnsi(req) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    return params.get('stripAnsi') !== 'false';
}

function _maybeStrip(s, strip) {
    return s && strip ? stripAnsiControlCodes(s, { all: true }) : s;
}

function _serializeArea(area, strip = true) {
    return {
        areaTag: area.areaTag,
        name: area.name || area.areaTag,
        desc: _maybeStrip(area.desc, strip) || undefined,
    };
}

function _serializeFileEntry(entry, strip = true) {
    return {
        fileId: entry.fileId,
        areaTag: entry.areaTag,
        fileName: entry.fileName,
        desc: _maybeStrip(entry.desc, strip) || undefined,
        descLong: _maybeStrip(entry.descLong, strip) || undefined,
        byteSize: entry.meta?.byte_size ? parseInt(entry.meta.byte_size, 10) : undefined,
        uploadTimestamp: entry.uploadTimestamp
            ? moment(entry.uploadTimestamp).toISOString()
            : undefined,
        uploadByUsername: entry.meta?.upload_by_username || undefined,
        dlCount: entry.meta?.dl_count ? parseInt(entry.meta.dl_count, 10) : 0,
        sha256: entry.fileSha256 || undefined,
        archiveType: entry.meta?.archive_type || undefined,
        hashTags: entry.hashTags ? [...entry.hashTags] : [],
        estReleaseYear: entry.meta?.est_release_year
            ? parseInt(entry.meta.est_release_year, 10)
            : undefined,
    };
}

function _areasHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    resolveAuthenticatedUser(req, (err, authedUser) => {
        if (authedUser) {
            User.getUser(authedUser.userId, (err, user) => {
                if (err || !user) {
                    return problemDetail(resp, 401, 'Authentication Required');
                }
                const fakeClient = { acs: _acsForUser(user) };
                const areas = getAvailableFileAreas(fakeClient, {});
                const strip = _shouldStripAnsi(req);
                const data = Object.values(areas).map(a => _serializeArea(a, strip));
                return jsonResponse(resp, 200, paginationMeta(data, null));
            });
        } else {
            //  Unauthenticated: only areas in the public allowlist
            const areas = getAvailableFileAreas(null, { skipAcsCheck: true });
            const strip = _shouldStripAnsi(req);
            const data = Object.values(areas)
                .filter(a => _isAreaPublic(a.areaTag))
                .map(a => _serializeArea(a, strip));
            return jsonResponse(resp, 200, paginationMeta(data, null));
        }
    });
}

function _areaDetailHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const areaTag = req.url.match(/\/areas\/([^/?]+)(?:[?#]|$)/)?.[1];
    if (!areaTag) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    _resolveAreaReadAccess(req, resp, areaTag, (_user, area) => {
        return jsonResponse(resp, 200, _serializeArea(area, _shouldStripAnsi(req)));
    });
}

function _fileListHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const areaTag = req.url.match(/\/areas\/([^/?]+)\/files/)?.[1];
    if (!areaTag) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    _resolveAreaReadAccess(req, resp, areaTag, (_user, _area) => {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const strip = params.get('stripAnsi') !== 'false';
        const limit = Math.min(
            parseInt(params.get('limit') || PAGE_SIZE, 10),
            MAX_PAGE_SIZE
        );
        const cursorParam = params.get('cursor');

        let afterFileId = 0;
        if (cursorParam) {
            const decoded = decodeCursor(cursorParam);
            afterFileId = decoded?.fileId || 0;
        }

        FileEntry.findFiles(
            {
                areaTag,
                sort: 'file_id',
                order: 'ascending',
                newerThanFileId: afterFileId,
                limit: limit + 1,
            },
            (err, fileIds) => {
                if (err) {
                    log.error({ err, areaTag }, 'Error listing files');
                    return problemDetail(resp, 500, 'Internal Server Error');
                }

                const hasMore = fileIds.length > limit;
                if (hasMore) {
                    fileIds = fileIds.slice(0, limit);
                }

                //  Load basic entries for each ID
                const entries = [];
                let loadErr = null;
                let pending = fileIds.length;

                if (pending === 0) {
                    return jsonResponse(resp, 200, paginationMeta([], null));
                }

                fileIds.forEach((fileId, idx) => {
                    const entry = new FileEntry();
                    FileEntry.loadBasicEntry(fileId, entry, err => {
                        if (err) {
                            loadErr = err;
                        } else {
                            entries[idx] = entry;
                        }
                        if (--pending === 0) {
                            if (loadErr) {
                                log.error({ err: loadErr }, 'Error loading file entry');
                                return problemDetail(resp, 500, 'Internal Server Error');
                            }
                            const data = entries
                                .filter(Boolean)
                                .map(e => _serializeFileEntry(e, strip));
                            const lastEntry = data[data.length - 1];
                            const nextCursor =
                                hasMore && lastEntry
                                    ? encodeCursor({ fileId: lastEntry.fileId })
                                    : null;
                            return jsonResponse(
                                resp,
                                200,
                                paginationMeta(data, nextCursor)
                            );
                        }
                    });
                });
            }
        );
    });
}

function _fileMetaHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const fileId = parseInt(req.url.match(/\/files\/(\d+)/)?.[1], 10);
    if (!fileId) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    const entry = new FileEntry();
    entry.load(fileId, err => {
        if (err) {
            return problemDetail(resp, 404, 'Not Found', 'File not found');
        }

        _resolveAreaReadAccess(req, resp, entry.areaTag, () => {
            return jsonResponse(
                resp,
                200,
                _serializeFileEntry(entry, _shouldStripAnsi(req))
            );
        });
    });
}

function _downloadHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const fileId = parseInt(req.url.match(/\/files\/(\d+)\/download/)?.[1], 10);
    if (!fileId) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    requireAuth(req, resp, authedUser => {
        User.getUser(authedUser.userId, (err, user) => {
            if (err || !user) {
                return problemDetail(resp, 401, 'Authentication Required');
            }

            const entry = new FileEntry();
            entry.load(fileId, err => {
                if (err) {
                    return problemDetail(resp, 404, 'Not Found', 'File not found');
                }

                if (isInternalArea(entry.areaTag)) {
                    return problemDetail(resp, 403, 'Forbidden');
                }

                const area = getFileAreaByTag(entry.areaTag);
                if (!area) {
                    return problemDetail(resp, 404, 'Not Found', 'File area not found');
                }

                const acs = _acsForUser(user);
                if (!acs.hasFileAreaDownload(area)) {
                    return problemDetail(
                        resp,
                        403,
                        'Forbidden',
                        'Insufficient download access'
                    );
                }

                let filePath;
                try {
                    filePath = entry.filePath;
                } catch {
                    log.error({ fileId }, 'Path traversal detected on download');
                    return problemDetail(resp, 403, 'Forbidden');
                }

                fs.stat(filePath, (err, stat) => {
                    if (err) {
                        log.error({ err, filePath }, 'File not found on disk');
                        return problemDetail(
                            resp,
                            404,
                            'Not Found',
                            'File not found on disk'
                        );
                    }

                    const mimeType =
                        mimeTypes.lookup(entry.fileName) || 'application/octet-stream';
                    const safeFileName = paths
                        .basename(entry.fileName)
                        .replace(/[^\w.\-]/g, '_');

                    resp.writeHead(200, {
                        'Content-Type': mimeType,
                        'Content-Length': stat.size,
                        'Content-Disposition': `attachment; filename="${safeFileName}"`,
                        'X-File-Id': String(fileId),
                    });

                    const stream = fs.createReadStream(filePath);
                    stream.on('error', streamErr => {
                        log.error(
                            { err: streamErr, fileId },
                            'Stream error during download'
                        );
                        if (!resp.headersSent) {
                            return problemDetail(resp, 500, 'Internal Server Error');
                        }
                        resp.destroy();
                    });
                    stream.pipe(resp);

                    FileEntry.incrementAndPersistMetaValue(fileId, 'dl_count', 1, err => {
                        if (err) {
                            log.warn({ err, fileId }, 'Failed to increment dl_count');
                        }
                    });

                    StatLog.incrementUserStat(user, UserProps.FileDlTotalCount, 1);
                    StatLog.incrementUserStat(
                        user,
                        UserProps.FileDlTotalBytes,
                        stat.size
                    );
                    StatLog.incrementSystemStat(SysProps.FileDlTotalCount, 1);

                    log.info(
                        { userId: user.userId, fileId, fileName: entry.fileName },
                        'File downloaded via REST API'
                    );
                });
            });
        });
    });
}

function _uploadHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const areaTag = req.url.match(/\/areas\/([^/?]+)(?:[?#]|$)/)?.[1];
    if (!areaTag) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    requireAuth(req, resp, authedUser => {
        User.getUser(authedUser.userId, (err, user) => {
            if (err || !user) {
                return problemDetail(resp, 401, 'Authentication Required');
            }

            if (isInternalArea(areaTag)) {
                return problemDetail(resp, 403, 'Forbidden');
            }

            const area = getFileAreaByTag(areaTag);
            if (!area) {
                return problemDetail(
                    resp,
                    404,
                    'Not Found',
                    `Area '${areaTag}' not found`
                );
            }

            const acs = _acsForUser(user);
            if (!acs.hasFileAreaWrite(area)) {
                return problemDetail(
                    resp,
                    403,
                    'Forbidden',
                    'Insufficient upload access'
                );
            }

            const contentType = req.headers['content-type'] || '';
            if (!contentType.includes('multipart/form-data')) {
                return problemDetail(
                    resp,
                    400,
                    'Bad Request',
                    'Content-Type must be multipart/form-data'
                );
            }

            _parseMultipartUpload(req, resp, log, (err, uploadInfo) => {
                if (err) {
                    return problemDetail(resp, 400, 'Bad Request', err.message);
                }

                const storageTag = area.storageTags?.[0];
                if (!storageTag) {
                    return problemDetail(
                        resp,
                        500,
                        'Internal Server Error',
                        'Area has no storage tag configured'
                    );
                }

                const storageDir = getAreaDefaultStorageDirectory(area);
                const destPath = paths.join(storageDir, uploadInfo.fileName);

                //  Guard against traversal in the filename itself
                if (
                    !destPath.startsWith(storageDir + paths.sep) &&
                    destPath !== storageDir
                ) {
                    return problemDetail(resp, 400, 'Bad Request', 'Invalid filename');
                }

                fs.rename(uploadInfo.tempPath, destPath, err => {
                    if (err) {
                        fs.unlink(uploadInfo.tempPath, () => {});
                        log.error({ err, destPath }, 'Failed to move uploaded file');
                        return problemDetail(resp, 500, 'Internal Server Error');
                    }

                    scanFile(
                        destPath,
                        {
                            areaTag,
                            storageTag,
                            meta: {
                                upload_by_username: user.username,
                                upload_by_user_id: user.userId,
                                byte_size: uploadInfo.size,
                            },
                            desc: uploadInfo.desc || undefined,
                        },
                        (err, fileEntry, _dupeEntries) => {
                            if (err) {
                                log.error(
                                    { err, destPath },
                                    'Failed to scan uploaded file'
                                );
                                return problemDetail(resp, 500, 'Internal Server Error');
                            }

                            fileEntry.persist(err => {
                                if (err) {
                                    log.error(
                                        { err, destPath },
                                        'Failed to persist uploaded file entry'
                                    );
                                    return problemDetail(
                                        resp,
                                        500,
                                        'Internal Server Error'
                                    );
                                }

                                log.info(
                                    {
                                        userId: user.userId,
                                        areaTag,
                                        fileId: fileEntry.fileId,
                                        fileName: uploadInfo.fileName,
                                    },
                                    'File uploaded via REST API'
                                );

                                return jsonResponse(
                                    resp,
                                    201,
                                    _serializeFileEntry(fileEntry, _shouldStripAnsi(req))
                                );
                            });
                        }
                    );
                });
            });
        });
    });
}

//  Minimal multipart/form-data parser — handles a single file part plus
//  optional 'desc' text field. Uses a temp file to avoid buffering large
//  uploads in memory.
function _parseMultipartUpload(req, resp, log, cb) {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
    if (!boundaryMatch) {
        return cb(new Error('Missing multipart boundary'));
    }
    const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]);

    const tmpPath = paths.join(
        require('os').tmpdir(),
        `enig_upload_${crypto.randomBytes(8).toString('hex')}`
    );

    let totalBytes = 0;
    let fileName = null;
    let desc = null;
    let fileSize = 0;

    const chunks = [];
    req.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_UPLOAD_BYTES) {
            req.destroy();
            return cb(new Error('Upload exceeds maximum allowed size'));
        }
        chunks.push(chunk);
    });

    req.on('error', cb);

    req.on('end', () => {
        const buf = Buffer.concat(chunks);
        const bodyStr = buf.toString('binary');

        //  Split on boundary lines
        const parts = bodyStr.split(boundary).slice(1); // skip preamble

        let fileBuffer = null;

        for (const part of parts) {
            if (part.startsWith('--')) {
                break;
            } // final boundary

            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                continue;
            }

            const headerBlock = part.slice(0, headerEnd);
            const body = part.slice(headerEnd + 4, part.length - 2); // strip trailing \r\n

            const dispMatch = headerBlock.match(/Content-Disposition:[^\r\n]*/i);
            if (!dispMatch) {
                continue;
            }
            const dispLine = dispMatch[0];
            const nameMatch = dispLine.match(/name="([^"]+)"/i);
            if (!nameMatch) {
                continue;
            }
            const fieldName = nameMatch[1];
            const fileNameMatch = dispLine.match(/filename="([^"]+)"/i);
            const partFileName = fileNameMatch ? fileNameMatch[1] : null;

            if (partFileName) {
                //  This is the file part
                fileName = paths.basename(partFileName).replace(/[^\w.\-]/g, '_');
                fileBuffer = Buffer.from(body, 'binary');
                fileSize = fileBuffer.length;
            } else if (fieldName === 'desc') {
                desc = body.trim();
            }
        }

        if (!fileName || !fileBuffer) {
            return cb(new Error('No file part found in multipart body'));
        }

        fs.writeFile(tmpPath, fileBuffer, err => {
            if (err) {
                return cb(err);
            }
            return cb(null, { tempPath: tmpPath, fileName, desc, size: fileSize });
        });
    });
}
