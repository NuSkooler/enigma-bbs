const WebHandlerModule = require('../../../web_handler_module');
const Config = require('../../../config').get;
const { Errors } = require('../../../enig_error');
const { WellKnownLocations } = require('../web');
const {
  selfUrl,
  webFingerProfileUrl,
  userFromAccount,
  getUserProfileTemplatedBody,
  DefaultProfileTemplate,
} = require('../../../activitypub_util');

const _ = require('lodash');
const enigma_assert = require('../../../enigma_assert');

exports.moduleInfo = {
  name: 'WebFinger',
  desc: 'A simple WebFinger Handler.',
  author: 'NuSkooler, CognitiveGears',
  packageName: 'codes.l33t.enigma.web.handler.webfinger',
};

//
//  WebFinger: https://www.rfc-editor.org/rfc/rfc7033
//
exports.getModule = class WebFingerWebHandler extends WebHandlerModule {
  constructor() {
    super();
  }

  init(webServer, cb) {
    // we rely on the web server
    this.webServer = webServer;
    enigma_assert(webServer, 'WebFinger Web Handler init without webServer');

    this.log = webServer.logger().child({ webHandler: 'WebFinger' });

    const domain = this.webServer.getDomain();
    if (!domain) {
      return cb(Errors.UnexpectedState('Web server does not have "domain" set'));
    }

    this.acceptedResourceRegExps = [
      // acct:NAME@our.domain.tld
      // https://www.rfc-editor.org/rfc/rfc7565
      new RegExp(`^acct:(.+)@${domain}$`),
      // profile page
      // https://webfinger.net/rel/profile-page/
      new RegExp(
        `^${this.webServer.buildUrl(WellKnownLocations.Internal + '/wf/@')}(.+)$`
      ),
      // self URL
      new RegExp(
        `^${this.webServer.buildUrl(
          WellKnownLocations.Internal + '/ap/users/'
        )}(.+)$`
      ),
    ];

    this.webServer.addRoute({
      method: 'GET',
      // https://www.rfc-editor.org/rfc/rfc7033.html#section-10.1
      path: /^\/\.well-known\/webfinger\/?\?/,
      handler: this._webFingerRequestHandler.bind(this),
    });

    this.webServer.addRoute({
      method: 'GET',
      path: /^\/_enig\/wf\/@.+$/,
      handler: this._profileRequestHandler.bind(this),
    });

    return cb(null);
  }

  _profileRequestHandler(req, resp) {
    const url = new URL(req.url, `https://${req.headers.host}`);

    const resource = url.pathname;
    if (_.isEmpty(resource)) {
      return this.webServer.instance.respondWithError(
        resp,
        400,
        'pathname is required',
        'Missing "resource"'
      );
    }

    const userPosition = resource.indexOf('@');
    if (-1 == userPosition || userPosition == resource.length - 1) {
      this._notFound(resp);
      return Errors.DoesNotExist('"@username" missing from path');
    }

    const accountName = resource.substring(userPosition + 1);

    userFromAccount(accountName, (err, user) => {
      if (err) {
        this.log.warn(
          { url: req.url, error: err.message, type: 'Profile' },
          `No profile for "${accountName}" could be retrieved`
        );
        return this._notFound(resp);
      }

      let templateFile = _.get(
        Config(),
        'contentServers.web.handlers.webFinger.profileTemplate'
      );
      if (templateFile) {
        templateFile = this.webServer.resolveTemplatePath(templateFile);
      }

      getUserProfileTemplatedBody(
        templateFile,
        user,
        DefaultProfileTemplate,
        'text/plain',
        (err, body, contentType) => {
          if (err) {
            return this._notFound(resp);
          }

          const headers = {
            'Content-Type': contentType,
            'Content-Length': body.length,
          };

          resp.writeHead(200, headers);
          return resp.end(body);
        }
      );
    });
  }

  _webFingerRequestHandler(req, resp) {
    const url = new URL(req.url, `https://${req.headers.host}`);

    const resource = url.searchParams.get('resource');
    if (!resource) {
      return this.webServer.respondWithError(
        resp,
        400,
        '"resource" is required',
        'Missing "resource"'
      );
    }

    const accountName = this._getAccountName(resource);
    if (!accountName || accountName.length < 1) {
      this._notFound(resp);
      return Errors.DoesNotExist(
        `Failed to parse "account name" for resource: ${resource}`
      );
    }

    userFromAccount(accountName, (err, user) => {
      if (err) {
        this.log.warn(
          { url: req.url, error: err.message, type: 'WebFinger' },
          `No account for "${accountName}" could be retrieved`
        );
        return this._notFound(resp);
      }

      const domain = this.webServer.getDomain();

      const body = JSON.stringify({
        subject: `acct:${user.username}@${domain}`,
        aliases: [this._profileUrl(user), this._selfUrl(user)],
        links: [
          this._profilePageLink(user),
          this._selfLink(user),
          this._subscribeLink(),
        ],
      });

      const headers = {
        'Content-Type': 'application/jrd+json',
        'Content-Length': body.length,
      };

      resp.writeHead(200, headers);
      return resp.end(body);
    });
  }

  _profileUrl(user) {
    return webFingerProfileUrl(this.webServer, user);
  }

  _profilePageLink(user) {
    const href = this._profileUrl(user);
    return {
      rel: 'http://webfinger.net/rel/profile-page',
      type: 'text/plain',
      href,
    };
  }

  _selfUrl(user) {
    return selfUrl(this.webServer, user);
  }

  // :TODO: only if ActivityPub is enabled
  _selfLink(user) {
    const href = this._selfUrl(user);
    return {
      rel: 'self',
      type: 'application/activity+json',
      href,
    };
  }

  // :TODO: only if ActivityPub is enabled
  _subscribeLink() {
    return {
      rel: 'http://ostatus.org/schema/1.0/subscribe',
      template: this.webServer.buildUrl(
        WellKnownLocations.Internal + '/ap/authorize_interaction?uri={uri}'
      ),
    };
  }

  _getAccountName(resource) {
    for (const re of this.acceptedResourceRegExps) {
      const m = resource.match(re);
      if (m && m.length === 2) {
        return m[1];
      }
    }
  }

  _notFound(resp) {
    this.webServer.respondWithError(
      resp,
      404,
      'Resource not found',
      'Resource Not Found'
    );
  }
};
