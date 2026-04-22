'use strict';

const { strict: assert } = require('assert');
const paths = require('path');

//  ConfigLoader has no load-time Config() dependency — require directly.
const ConfigLoader = require('../core/config_loader');

// ─── getRaw() ────────────────────────────────────────────────────────────────

describe('ConfigLoader.getRaw()', () => {
    it('returns this.current when rawConfig has not been set', () => {
        const loader = new ConfigLoader();
        loader.current = { foo: 'bar' };
        assert.deepEqual(loader.getRaw(), { foo: 'bar' });
    });

    it('returns rawConfig even after current is overwritten externally', () => {
        const loader = new ConfigLoader();
        loader.rawConfig = { raw: true };
        loader.current = { merged: true }; //  simulates what _finalizeTheme does
        assert.deepEqual(loader.getRaw(), { raw: true });
        assert.deepEqual(loader.get(), { merged: true });
    });

    it('rawConfig is populated by _reload completion', done => {
        const loader = new ConfigLoader({ hotReload: false });
        loader.baseConfigPath = '/fake/config.hjson';

        //  Stub _loadConfigFile to avoid real FS; feed back a known config.
        loader._loadConfigFile = (filePath, cb) => cb(null, { key: 'value' });
        loader._resolveIncludes = (root, config, cb) => {
            loader.configPaths = [loader.baseConfigPath];
            return cb(null, config);
        };

        loader._reload(loader.baseConfigPath, err => {
            assert.ifError(err);
            assert.deepEqual(loader.rawConfig, { key: 'value' });
            assert.deepEqual(loader.current, { key: 'value' });
            done();
        });
    });

    it('rawConfig survives a subsequent external write to current', done => {
        const loader = new ConfigLoader({ hotReload: false });
        loader.baseConfigPath = '/fake/config.hjson';

        loader._loadConfigFile = (filePath, cb) => cb(null, { original: true });
        loader._resolveIncludes = (root, config, cb) => {
            loader.configPaths = ['/fake/config.hjson'];
            return cb(null, config);
        };

        loader._reload(loader.baseConfigPath, err => {
            assert.ifError(err);
            //  Simulate what ThemeManager._finalizeTheme does
            loader.current = { merged: true, menus: {}, original: true };
            assert.deepEqual(loader.getRaw(), { original: true });
            assert.deepEqual(loader.get(), { merged: true, menus: {}, original: true });
            done();
        });
    });
});

// ─── _configFileChanged guard ─────────────────────────────────────────────────

describe('ConfigLoader._configFileChanged()', () => {
    it('does not throw when configPaths is undefined (guard against early watcher fire)', () => {
        const loader = new ConfigLoader({ hotReload: false });
        loader.baseConfigPath = '/fake/config.hjson';
        //  configPaths intentionally NOT set — simulates watcher firing before init completes

        assert.doesNotThrow(() => {
            loader._configFileChanged({ fileName: 'config.hjson', fileRoot: '/fake' });
        });
    });

    it('does not schedule a reload when the changed path is not tracked', () => {
        const loader = new ConfigLoader({ hotReload: false });
        loader.baseConfigPath = '/fake/config.hjson';
        loader.configPaths = ['/fake/config.hjson'];

        let scheduled = false;
        loader._scheduleReload = () => {
            scheduled = true;
        };

        loader._configFileChanged({ fileName: 'other.hjson', fileRoot: '/fake' });
        assert.equal(scheduled, false);
    });

    it('schedules a reload when a tracked path changes', () => {
        const loader = new ConfigLoader({ hotReload: false });
        loader.baseConfigPath = '/fake/config.hjson';
        loader.configPaths = ['/fake/config.hjson'];

        let scheduled = false;
        loader._scheduleReload = () => {
            scheduled = true;
        };

        loader._configFileChanged({ fileName: 'config.hjson', fileRoot: '/fake' });
        assert.equal(scheduled, true);
    });
});

// ─── debounce ─────────────────────────────────────────────────────────────────

describe('ConfigLoader debounce (_scheduleReload)', () => {
    it('_scheduleReload is a lodash debounced function (has .flush and .cancel)', () => {
        const loader = new ConfigLoader({ hotReload: false });
        assert.equal(typeof loader._scheduleReload.flush, 'function');
        assert.equal(typeof loader._scheduleReload.cancel, 'function');
    });

    it('coalesces multiple rapid _configFileChanged calls into a single _reload', () => {
        const loader = new ConfigLoader({ hotReload: false });
        loader.baseConfigPath = '/fake/config.hjson';
        loader.configPaths = ['/fake/config.hjson'];

        let reloadCount = 0;
        //  _scheduleReload is a debounced wrapper around this._reload; replace _reload
        //  to count invocations without doing real work.
        loader._reload = (p, cb) => {
            reloadCount++;
            cb(null);
        };

        //  Trigger three rapid changes
        loader._configFileChanged({ fileName: 'config.hjson', fileRoot: '/fake' });
        loader._configFileChanged({ fileName: 'config.hjson', fileRoot: '/fake' });
        loader._configFileChanged({ fileName: 'config.hjson', fileRoot: '/fake' });

        //  Debounce has not fired yet
        assert.equal(reloadCount, 0);

        //  Force the pending debounced call to fire immediately
        loader._scheduleReload.flush();

        assert.equal(
            reloadCount,
            1,
            'Expected exactly one _reload despite three rapid changes'
        );
    });

    it('fires onReload callback once after debounced flush', done => {
        let onReloadCount = 0;
        const loader = new ConfigLoader({
            hotReload: false,
            onReload: () => {
                onReloadCount++;
            },
        });
        loader.baseConfigPath = '/fake/config.hjson';
        loader.configPaths = ['/fake/config.hjson'];

        loader._reload = (p, cb) => cb(null);

        loader._configFileChanged({ fileName: 'config.hjson', fileRoot: '/fake' });
        loader._configFileChanged({ fileName: 'config.hjson', fileRoot: '/fake' });

        loader._scheduleReload.flush();

        //  onReload is called inside the _reload callback which is sync here
        setImmediate(() => {
            assert.equal(onReloadCount, 1);
            done();
        });
    });
});
