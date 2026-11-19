'use strict';

const { strict: assert } = require('assert');

const { MenuModule } = require('../core/menu_module.js');

//  Built without the constructor, as test/menu_module_cursor.test.js does: the
//  lookup needs only |menuConfig| and |viewControllers|.
class DefaultsModule extends MenuModule {
    getDefaultCustomInfoFormats(formName) {
        return 'main' === formName ? { 10: '{count} new', 11: 'Hi {name}' } : {};
    }
}

//  A view that only records what it is given
function makeView(id) {
    return {
        id,
        text: '',
        hasDrawnOnce: true,
        setText(t) {
            this.text = t;
        },
        getData() {
            return this.text;
        },
        redraw() {},
    };
}

function makeModule(Klass, config) {
    const views = { 10: makeView(10), 11: makeView(11), 12: makeView(12) };
    const mod = Object.create(Klass.prototype);
    mod.client = { term: { termWidth: 80 } };
    mod.menuConfig = { config };
    mod.viewControllers = {
        main: { getView: id => views[id], getFocusedView: () => null },
    };
    return { mod, views };
}

const ids = views => views.map(v => v.id);

describe('MenuModule custom info format defaults', () => {
    it('without defaults behaves as before', () => {
        const { mod, views } = makeModule(MenuModule, { mainInfoFormat10: 'A {count}' });
        assert.deepEqual(ids(mod.getCustomViewsWithFilter('main', 10)), [10]);
        mod.updateCustomViewTextsWithFilter('main', 10, { count: 3 });
        assert.equal(views[10].text, 'A 3');
        assert.equal(views[11].text, '');
        assert.equal(mod.getCustomInfoFormat('main', 11), undefined);
    });

    it('without defaults an empty string is still unset', () => {
        const { mod } = makeModule(MenuModule, { mainInfoFormat10: '' });
        assert.deepEqual(mod.getCustomViewsWithFilter('main', 10), []);
    });

    it('uses the module default when the operator sets nothing', () => {
        const { mod, views } = makeModule(DefaultsModule, {});
        assert.deepEqual(ids(mod.getCustomViewsWithFilter('main', 10)), [10, 11]);
        mod.updateCustomViewTextsWithFilter('main', 10, { count: 2, name: 'Bo' });
        assert.equal(views[10].text, '2 new');
        assert.equal(views[11].text, 'Hi Bo');
        assert.equal(views[12].text, '');
    });

    it('operator format wins over the default', () => {
        const { mod, views } = makeModule(DefaultsModule, {
            mainInfoFormat10: 'Mine {count}',
        });
        mod.updateCustomViewTextsWithFilter('main', 10, { count: 2, name: 'Bo' });
        assert.equal(views[10].text, 'Mine 2');
        assert.equal(views[11].text, 'Hi Bo');
    });

    it('an operator empty string hides a defaulted view', () => {
        const { mod, views } = makeModule(DefaultsModule, { mainInfoFormat10: '' });
        assert.deepEqual(ids(mod.getCustomViewsWithFilter('main', 10)), [11]);
        mod.updateCustomViewTextsWithFilter('main', 10, { count: 2, name: 'Bo' });
        assert.equal(views[10].text, '');
        assert.equal(views[11].text, 'Hi Bo');
    });

    it('an operator null or false hides a defaulted view', () => {
        for (const value of [null, false]) {
            const { mod, views } = makeModule(DefaultsModule, {
                mainInfoFormat10: value,
            });
            assert.deepEqual(ids(mod.getCustomViewsWithFilter('main', 10)), [11]);
            mod.updateCustomViewTextsWithFilter('main', 10, { count: 2, name: 'Bo' });
            assert.equal(views[10].text, '');
        }
    });

    it('options.filter tests the default format', () => {
        const { mod } = makeModule(DefaultsModule, {});
        assert.deepEqual(
            ids(mod.getCustomViewsWithFilter('main', 10, { filter: ['{count'] })),
            [10]
        );
        assert.deepEqual(
            ids(mod.getCustomViewsWithFilter('main', 10, { filter: ['{nope'] })),
            []
        );
    });

    it('options.filter tests the operator format, not the default', () => {
        const { mod } = makeModule(DefaultsModule, { mainInfoFormat10: 'plain' });
        assert.deepEqual(
            ids(mod.getCustomViewsWithFilter('main', 10, { filter: ['{count'] })),
            []
        );
    });

    it('never writes defaults into menuConfig', () => {
        const config = {};
        const { mod } = makeModule(DefaultsModule, config);
        mod.updateCustomViewTextsWithFilter('main', 10, { count: 1, name: 'x' });
        assert.deepEqual(config, {});
    });

    it('defaults are per form', () => {
        const { mod } = makeModule(DefaultsModule, {});
        assert.equal(mod.getCustomInfoFormat('other', 10), undefined);
    });
});
