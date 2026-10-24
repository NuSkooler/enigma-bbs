'use strict';

//
//  Static files are looked up by the path part of the request URL. The whole
//  URL used to be taken as the file name, so a shared link that came back with
//  Facebook's ?fbclid=... appended -- or any ?v= cache-buster -- was a 404.
//

const { strict: assert } = require('assert');

const WebServerModule = require('../core/servers/content/web.js').getModule;

describe('WebServerModule staticRequestPath()', function () {
    //  The method is on the prototype and touches no server state or config.
    const web = Object.create(WebServerModule.prototype);
    const pathOf = url => web.staticRequestPath({ url });

    it('returns a plain path unchanged', () => {
        assert.equal(pathOf('/'), '/');
        assert.equal(pathOf('/about/'), '/about/');
        assert.equal(pathOf('/css/site.css'), '/css/site.css');
    });

    it('drops a query string', () => {
        assert.equal(pathOf('/about/?fbclid=IwAR0abc'), '/about/');
        assert.equal(pathOf('/?fbclid=IwAR0abc'), '/');
        assert.equal(pathOf('/css/site.css?v=2'), '/css/site.css');
    });

    it('drops a fragment', () => {
        assert.equal(pathOf('/about/#section'), '/about/');
        assert.equal(pathOf('/about/?a=1#section'), '/about/');
    });

    it('treats an empty query as no query', () => {
        assert.equal(pathOf('/about/?'), '/about/');
    });

    it('leaves traversal for resolveStaticPath to reject', () => {
        //  Not this method's job: the path still reaches the root check intact.
        assert.equal(pathOf('/../etc/passwd?x=1'), '/../etc/passwd');
    });
});
