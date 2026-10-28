'use strict';

//
//  Route validity for the web server: a route needs a RegExp path, a known
//  method and a handler function; a bad path is rejected, not thrown.
//

const { strict: assert } = require('assert');

describe('web server Route', () => {
    const logged = [];
    let Route;

    //  web.js captures the system logger when it loads, and the logger only
    //  exists once the BBS has initialised it. Load a private copy of the
    //  module against a stub, then put the cache back as it was.
    before(() => {
        const Logger = require('../core/logger.js');
        const webPath = require.resolve('../core/servers/content/web.js');
        const savedLog = Logger.log;
        const savedModule = require.cache[webPath];

        Logger.log = {
            error: (...args) => logged.push(args),
            warn: () => {},
            info: () => {},
            debug: () => {},
            trace: () => {},
        };
        try {
            delete require.cache[webPath];
            Route = require(webPath).Route;
        } finally {
            Logger.log = savedLog;
            if (savedModule) {
                require.cache[webPath] = savedModule;
            } else {
                delete require.cache[webPath];
            }
        }
    });

    beforeEach(() => {
        logged.length = 0;
    });

    const handler = () => {};

    it('accepts a route with a path, a known method and a handler', () => {
        assert.equal(
            new Route({ method: 'get', path: /^\/x$/, handler }).isValid(),
            true
        );
    });

    it('rejects a route without a handler', () => {
        assert.equal(new Route({ method: 'GET', path: /^\/x$/ }).isValid(), false);
    });

    it('rejects a route whose handler is not a function', () => {
        assert.equal(
            new Route({ method: 'GET', path: /^\/x$/, handler: 'nope' }).isValid(),
            false
        );
    });

    it('rejects an unknown method', () => {
        assert.equal(
            new Route({ method: 'FETCH', path: /^\/x$/, handler }).isValid(),
            false
        );
    });

    it('rejects an invalid path and logs it without throwing', () => {
        let route;
        assert.doesNotThrow(() => {
            route = new Route({ method: 'GET', path: '([unclosed', handler });
        });
        assert.equal(route.pathRegExp, undefined);
        assert.equal(route.isValid(), false);
        assert.equal(logged.length, 1);
    });
});
