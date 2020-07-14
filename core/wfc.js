//  ENiGMA½
const { MenuModule } = require('./menu_module');

exports.moduleInfo = {
    name        : 'WFC',
    desc        : 'Semi-Traditional Waiting For Caller',
    author      : 'NuSkooler',
};

exports.getModule = class WaitingForCallerModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), { extraArgs : options.extraArgs });
    }
};

