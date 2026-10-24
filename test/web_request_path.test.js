'use strict';

//
//  Requests are served by the path part of their URL. The whole URL used to be
//  taken as the file name (and, for /_f/ download links, as the hash id), so a
//  link shared on Facebook -- which appends ?fbclid=... to every one -- or any
//  ?v= cache-buster was a 404.
//

const { strict: assert } = require('assert');
const paths = require('path');

//  file_area_web.js logs through the logger, which is not initialized in test
//  context: install a no-op mock before loading anything.
const loggerModule = require('../core/logger.js');
if (!loggerModule.log) {
    loggerModule.log = { warn() {}, info() {}, debug() {}, trace() {}, error() {} };
}

const configModule = require('../core/config.js');
const { getUrlPath } = require('../core/web_util.js');
const WebServerModule = require('../core/servers/content/web.js').getModule;
const configDefault = require('../core/config_default.js');

//  file_area_web.js exports an instance, built at load time from the board
//  name, so it needs a config that has one if this is the first load.
const previousConfig = configModule._pushTestConfig({
    debug: { assertsEnabled: false },
    general: { boardName: 'TestBoard' },
});
const FileAreaWeb = require('../core/file_area_web.js');
configModule._popTestConfig(previousConfig);

describe('getUrlPath()', function () {
    it('returns a plain path unchanged', () => {
        assert.equal(getUrlPath('/'), '/');
        assert.equal(getUrlPath('/about/'), '/about/');
        assert.equal(getUrlPath('/css/site.css'), '/css/site.css');
    });

    it('drops a query string', () => {
        assert.equal(getUrlPath('/about/?fbclid=IwAR0abc'), '/about/');
        assert.equal(getUrlPath('/?fbclid=IwAR0abc'), '/');
        assert.equal(getUrlPath('/css/site.css?v=2'), '/css/site.css');
    });

    it('drops a fragment', () => {
        assert.equal(getUrlPath('/about/#section'), '/about/');
        assert.equal(getUrlPath('/about/?a=1#section'), '/about/');
    });

    it('treats an empty query as no query', () => {
        assert.equal(getUrlPath('/about/?'), '/about/');
    });

    it('leaves traversal for the caller to reject', () => {
        assert.equal(getUrlPath('/../etc/passwd?x=1'), '/../etc/passwd');
    });
});

describe('WebServerModule static lookups', function () {
    //  The methods are on the prototype; resolveStaticPath is stubbed to record
    //  what each lookup asks for, so no config or file system is involved.
    function makeWeb() {
        const web = Object.create(WebServerModule.prototype);
        web.requested = [];
        web.resolveStaticPath = (requestPath, cb) => {
            web.requested.push(requestPath);
            return cb(null, null);
        };
        return web;
    }

    it('staticRequestPath() drops the query and keeps the path', () => {
        const web = makeWeb();
        assert.equal(web.staticRequestPath({ url: '/about/?fbclid=x' }), '/about/');
        assert.equal(
            web.staticRequestPath({ url: '/css/site.css?v=2' }),
            '/css/site.css'
        );
    });

    it('staticRequestPath() still strips one slash from a // prefix', () => {
        assert.equal(makeWeb().staticRequestPath({ url: '//x/y?z' }), '/x/y');
    });

    it('tryStaticRoute() looks up the path, not the query', done => {
        const web = makeWeb();
        web.tryStaticRoute({ url: '/css/site.css?v=2' }, {}, wasHandled => {
            assert.ok(!wasHandled);
            assert.deepEqual(web.requested, ['/css/site.css']);
            return done();
        });
    });

    it('tryRouteIndex() looks for index files under the path, not the query', done => {
        const web = makeWeb();
        web.tryRouteIndex({ url: '/about/?fbclid=IwAR0abc' }, {}, wasHandled => {
            assert.ok(!wasHandled);
            assert.deepEqual(web.requested, [
                paths.join('/about/', 'index.html'),
                paths.join('/about/', 'index.htm'),
            ]);
            return done();
        });
    });
});

describe('file area web download links', function () {
    it('the default route accepts a query string', () => {
        const route = new RegExp(configDefault().fileBase.web.routePath);
        assert.ok(route.test('/_f/AbC123'));
        assert.ok(route.test('/_f/AbC123?fbclid=IwAR0abc'));
        assert.ok(!route.test('/_f/'));
        assert.ok(!route.test('/_f/AbC123/more'));
    });

    it('routeWebRequest() takes the hash id from the path, not the query', done => {
        const fileAreaWeb = Object.create(Object.getPrototypeOf(FileAreaWeb));
        fileAreaWeb.loadServedHashId = (hashId, cb) => {
            assert.equal(hashId, 'AbC123');
            return cb(new Error('not served'));
        };
        fileAreaWeb.fileNotFound = () => done();

        fileAreaWeb.routeWebRequest({ url: '/_f/AbC123?fbclid=IwAR0abc' }, {});
    });
});
