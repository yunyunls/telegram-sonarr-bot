'use strict';

var fs          = require('fs');                        // https://nodejs.org/api/fs.html
var _           = require('lodash');                    // https://www.npmjs.com/package/lodash
var NodeCache   = require('node-cache');                // https://www.npmjs.com/package/node-cache
var SonarrAPI   = require('sonarr-api');                // https://www.npmjs.com/package/sonarr-api
var TelegramBot = require('node-telegram-bot-api');     // https://www.npmjs.com/package/node-telegram-bot-api

var state  = require(__dirname + '/lib/state');         // handles command structure
var logger = require(__dirname + '/lib/logger');        // logs to file and console
var i18n   = require(__dirname + '/lib/lang');          // set up multilingual support
var config = require(__dirname + '/lib/config');        // the concised configuration

/*
 * import users
 */
try {
  var acl = require(__dirname + '/acl.json');
} catch (err) {
  var acl = {};
  acl.allowedUsers = [];
  acl.revokedUsers = [];
}

/*
 * define response class
 */
class Response {
  constructor(message, keyboard) {
    this.message = message;
    this.keyboard = keyboard;
  }
}

/*
 * set up the telegram bot
 */
var bot = new TelegramBot(config.telegram.botToken, {
  polling: true
});

/*
 * set up the sonarr api
 */
var sonarr = new SonarrAPI({
  hostname: config.sonarr.hostname, apiKey: config.sonarr.apiKey,
  port: config.sonarr.port, urlBase: config.sonarr.urlBase,
  ssl: config.sonarr.ssl, username: config.sonarr.username,
  password: config.sonarr.password
});

/*
 * set up a simple caching tool
 */
var cache = new NodeCache({ stdTTL: 120, checkperiod: 150 });

/*
 * get the bot name
 */
bot.getMe()
  .then(function(msg) {
    logger.info('sonarr bot %s initialized', msg.username);
  })
  .catch(function(err) {
    throw new Error(err);
  });

/*
 * handle start command
 */
bot.onText(/\/start/, function(msg) {
  var fromId = msg.from.id;

  logger.info('user: %s, message: sent \'/start\' command', fromId);

  if (!isAuthorized(fromId)) {
    return replyWithError(fromId, new Error(i18n.__('notAuthorized')));
  }

  var response = ['Hello ' + getTelegramName(msg.from) + ', use /q to search'];
  response.push('\n`/q [series name]` to continue...');

  var opts = {
    'parse_mode': 'Markdown',
    'selective': 2,
  };

  bot.sendMessage(fromId, response.join('\n'), opts);
});

/*
 * on query, select series
 */
bot.onText(/\/[Qq](uery)? (.+)/, function(msg, match) {
  var fromId = msg.from.id;
  var seriesName = match[2];

  verifyUser(fromId);

  logger.info('user: %s, message: sent \'/query\' command', fromId);

  sonarr.get('series/lookup', {
      'term': seriesName
    })
    .then(function(result) {
      if (!result.length) {
        throw new Error('could not find ' + seriesName + ', try searching again');
      }

      return result;
    })
    .then(function(series) {
      logger.info('user: %s, message: requested to search for series "%s"', fromId, seriesName);

      var seriesList = [];
      var keyboardList = [];

      series.length = (series.length > config.bot.maxResults ? config.bot.maxResults : series.length);

      var response = ['*Found ' + series.length + ' series:*'];

      _.forEach(series, function(n, key) {
        var id = key + 1;
        var keyboardValue = n.title + (n.year ? ' - ' + n.year : '');

        seriesList.push({
          'id': id,
          'title': n.title,
          'year': n.year,
          'tvdbId': n.tvdbId,
          'titleSlug': n.titleSlug,
          'seasons': n.seasons,
          'keyboardValue': keyboardValue
        });

        keyboardList.push([keyboardValue]);

        response.push(
          '*' + id + '*) ' +
          '[' + n.title + '](http://thetvdb.com/?tab=series&id=' + n.tvdbId + ')' +
          (n.year ? ' - _' + n.year + '_' : '')
        );
      });

      response.push(i18n.__('selectFromMenu'));

      logger.info('user: %s, message: found the following series %s', fromId, keyboardList.join(', '));

      // set cache
      cache.set('seriesList' + fromId, seriesList);
      cache.set('state' + fromId, state.sonarr.SERIES);

      return new Response(response.join('\n'), keyboardList);
    })
    .then(function(response) {
      var keyboard = {
        keyboard: response.keyboard,
        one_time_keyboard: true
      };
      var opts = {
        'disable_web_page_preview': true,
        'parse_mode': 'Markdown',
        'selective': 2,
        'reply_markup': JSON.stringify(keyboard),
      };
      bot.sendMessage(fromId, response.message, opts);
    })
    .catch(function(err) {
      replyWithError(fromId, err);
    });
});

/*
 Captures any and all messages, filters out commands, handles profiles and movies
 sent via the custom keyboard.
 */
bot.on('message', function(msg) {
  var fromId = msg.from.id;
  var message = msg.text;

  verifyUser(fromId);

  // If the message is a command, ignore it.
  var currentState = cache.get('state' + fromId);
  if (message[0] !== '/' || (currentState === state.sonarr.FOLDER && message[0] === '/')) {
    switch (currentState) {
      case state.sonarr.SERIES:
        logger.info('user: %s, message: choose the series %s', fromId, message);
        handleSeries(fromId, message);
        break;
      case state.sonarr.PROFILE:
        logger.info('user: %s, message: choose the profile "%s"', fromId, message);
        handleSeriesProfile(fromId, message);
        break;
      case state.sonarr.FOLDER:
        logger.info('user: %s, message: choose the folder "%s"', fromId, message);
        handleSeriesFolder(fromId, message);
        break;
      case state.sonarr.MONITOR:
        logger.info('user: %s, message: choose the monitor type "%s"', fromId, message);
        handleSeriesMonitor(fromId, message);
        break;
      case state.admin.REVOKE:
        verifyAdmin(fromId);
        logger.info('user: %s, message: choose to revoke user "%s"', fromId, message);
        handleRevokeUser(fromId, message);
        break;
      case state.admin.REVOKE_CONFIRM:
        verifyAdmin(fromId);
        logger.info('user: %s, message: choose the revoke confirmation "%s"', fromId, message);
        handleRevokeUserConfirm(fromId, message);
        break;
      case state.admin.UNREVOKE:
        verifyAdmin(fromId);
        logger.info('user: %s, message: choose to unrevoke user "%s"', fromId, message);
        handleUnRevokeUser(fromId, message);
        break;
      case state.admin.UNREVOKE_CONFIRM:
        verifyAdmin(fromId);
        logger.info('user: %s, message: choose the unrevoke confirmation "%s"', fromId, message);
        handleUnRevokeUserConfirm(fromId, message);
        break;
      default:
        logger.info('user: %s, message: received unknown message "%s"', fromId, message);
        replyWithError(fromId, new Error('Unsure what\'s going on, use the `/clear` command and start over.'));
    }
  }
});

/*
 * handle authorization
 */
bot.onText(/\/auth (.+)/, function(msg, match) {
  var fromId = msg.from.id;
  var password = match[1];

  var message = [];

  if (isAuthorized(fromId)) {
    message.push('Already authorized.');
    message.push('Type /start to begin.');
    return bot.sendMessage(fromId, message.join('\n'));
  }

  // make sure the user is not banned
  if (isRevoked(fromId)) {
    message.push('Your access has been revoked and cannot reauthorize.');
    message.push('Please reach out to the bot owner for support.');
    return bot.sendMessage(fromId, message.join('\n'));
  }

  if (password === config.bot.password) {
    acl.allowedUsers.push(msg.from);
    updateACL();

    if (acl.allowedUsers.length === 1) {
      promptOwnerConfig(fromId);
    }

    message.push('You have been authorized.');
    message.push('Type /start to begin.');
    bot.sendMessage(fromId, message.join('\n'));
  } else {
    bot.sendMessage(fromId, 'Invalid password.');
  }

  if (config.bot.owner) {
    bot.sendMessage(config.bot.owner, getTelegramName(msg.from) + ' has been granted access.');
  }
});

/*
 * handle users
 */
bot.onText(/\/users/, function(msg) {
  var fromId = msg.from.id;

  verifyAdmin(fromId);

  var response = ['*Allowed Users:*'];
  _.forEach(acl.allowedUsers, function(n, key) {
    response.push('*' + (key + 1) + '*) ' + getTelegramName(n));
  });

  var opts = {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
  };

  bot.sendMessage(fromId, response.join('\n'), opts);
});

/*
 * handle user access revocation
 */
bot.onText(/\/revoke/, function(msg) {
  var fromId = msg.from.id;

  verifyAdmin(fromId);

  var opts = {};

  if (acl.allowedUsers.length === 0) {
    var message = 'There aren\'t any allowed users.';
    opts = {
      'disable_web_page_preview': true,
      'parse_mode': 'Markdown',
      'selective': 2,
    };
    bot.sendMessage(fromId, message, opts);
  }

  var keyboardList = [];
  var keyboardRow = [];
  var revokeList = [];
  var response = ['*Allowed Users:*'];
  _.forEach(acl.allowedUsers, function(n, key) {
    revokeList.push({
      'id': key + 1,
      'userId': n.id,
      'keyboardValue': getTelegramName(n)
    });
    response.push('*' + (key + 1) + '*) ' + getTelegramName(n));

    keyboardRow.push(getTelegramName(n));
    if (keyboardRow.length == 2) {
      keyboardList.push(keyboardRow);
      keyboardRow = [];
    }
  });

  response.push(i18n.__('selectFromMenu'));


  if (keyboardRow.length == 1) {
    keyboardList.push([keyboardRow[0]]);
  }

  // set cache
  cache.set('state' + fromId, state.admin.REVOKE);
  cache.set('revokeUserList' + fromId, revokeList);

  var keyboard = {
    keyboard: keyboardList,
    one_time_keyboard: true
  };
  opts = {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
    'reply_markup': JSON.stringify(keyboard),
  };
  bot.sendMessage(fromId, response.join('\n'), opts);
});

/*
 * handle user access unrevocation
 */
bot.onText(/\/unrevoke/, function(msg) {
  var fromId = msg.from.id;

  verifyAdmin(fromId);

  var opts = {};

  if (acl.revokedUsers.length === 0) {
    var message = 'There aren\'t any revoked users.';
    opts = {
      'disable_web_page_preview': true,
      'parse_mode': 'Markdown',
      'selective': 2,
    };
    bot.sendMessage(fromId, message, opts);
  }

  var keyboardList = [];
  var keyboardRow = [];
  var revokeList = [];
  var response = ['*Revoked Users:*'];
  _.forEach(acl.revokedUsers, function(n, key) {
    revokeList.push({
      'id': key + 1,
      'userId': n.id,
      'keyboardValue': getTelegramName(n)
    });

    response.push('*' + (key + 1) + '*) ' + getTelegramName(n));

    keyboardRow.push(getTelegramName(n));
    if (keyboardRow.length == 2) {
      keyboardList.push(keyboardRow);
      keyboardRow = [];
    }
  });

  response.push(i18n.__('selectFromMenu'));

  if (keyboardRow.length == 1) {
    keyboardList.push([keyboardRow[0]]);
  }

  // set cache
  cache.set('state' + fromId, state.admin.UNREVOKE);
  cache.set('unrevokeUserList' + fromId, revokeList);

  var keyboard = {
    keyboard: keyboardList,
    one_time_keyboard: true
  };
  opts = {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
    'reply_markup': JSON.stringify(keyboard),
  };
  bot.sendMessage(fromId, response.join('\n'), opts);
});


/*
 * handle rss sync
 */
bot.onText(/\/rss/, function(msg) {
  var fromId = msg.from.id;

  verifyAdmin(fromId);

  logger.info('user: %s, message: sent \'/rss\' command', fromId);

  sonarr.post('command', {
      'name': 'RssSync'
    })
    .then(function() {
      logger.info('user: %s, message: \'/rss\' command successfully executed', fromId);
      bot.sendMessage(fromId, 'RSS Sync command sent.');
    })
    .catch(function(err) {
      replyWithError(fromId, err);
    });
});

/*
 * handle refresh series
 */
bot.onText(/\/refresh/, function(msg) {
  var fromId = msg.from.id;

  verifyAdmin(fromId);

  logger.info('user: %s, message: sent \'/refresh\' command', fromId);

  sonarr.post('command', {
      'name': 'RefreshSeries'
    })
    .then(function() {
      logger.info('user: %s, message: \'/refresh\' command successfully executed', fromId);
      bot.sendMessage(fromId, 'Refresh series command sent.');
    })
    .catch(function(err) {
      replyWithError(fromId, err);
    });
});

/*
 * handle clear command
 */
bot.onText(/\/clear/, function(msg) {
  var fromId = msg.from.id;

  verifyUser(fromId);

  logger.info('user: %s, message: sent \'/clear\' command', fromId);

  clearCache(fromId);

  logger.info('user: %s, message: \'/clear\' command successfully executed', fromId);

  bot.sendMessage(fromId, 'All previously sent commands have been cleared, yey!', {
    'reply_markup': {
      'hide_keyboard': true
    }
  });
});

function handleSeries(userId, seriesDisplayName) {
  var seriesList = cache.get('seriesList' + userId);
  if (seriesList === undefined) {
    throw new Error('something went wrong, try searching again');
  }

  var series = _.filter(seriesList, function(item) {
    return item.keyboardValue == seriesDisplayName;
  })[0];

  if (series === undefined) {
    throw new Error('could not find the series with title ' + seriesDisplayName);
  }

  var seriesId = series.id;

  cache.set('seriesId' + userId, seriesId);

  sonarr.get('profile')
    .then(function(result) {
      if (!result.length) {
        throw new Error('could not get profiles, try searching again');
      }

      if (cache.get('seriesList' + userId) === undefined) {
        throw new Error('could not get previous series list, try searching again');
      }

      return result;
    })
    .then(function(profiles) {
      logger.info('user: %s, message: requested to get profile list', userId);

      var profileList = [];
      var keyboardList = [];
      var keyboardRow = [];

      var response = ['*Found ' + profiles.length + ' profiles:*'];
      _.forEach(profiles, function(n, key) {
        profileList.push({
          'id': key + 1,
          'name': n.name,
          'label': n.name,
          'profileId': n.id
        });

        response.push('*' + (key + 1) + '*) ' + n.name);

        // Profile names are short, put two on each custom
        // keyboard row to reduce scrolling
        keyboardRow.push(n.name);
        if (keyboardRow.length === 2) {
          keyboardList.push(keyboardRow);
          keyboardRow = [];
        }
      });

      if (keyboardRow.length == 1) {
        keyboardList.push([keyboardRow[0]]);
      }
      response.push(i18n.__('selectFromMenu'));

      logger.info('user: %s, message: found the following profiles %s', userId, keyboardList.join(', '));

      // set cache
      cache.set('seriesProfileList' + userId, profileList);
      cache.set('state' + userId, state.sonarr.PROFILE);

      return new Response(response.join('\n'), keyboardList);
    })
    .then(function(response) {
      var keyboard = {
        keyboard: response.keyboard,
        one_time_keyboard: true
      };
      var opts = {
        'disable_web_page_preview': true,
        'parse_mode': 'Markdown',
        'selective': 2,
        'reply_markup': JSON.stringify(keyboard),
      };
      bot.sendMessage(userId, response.message, opts);
    })
    .catch(function(err) {
      replyWithError(userId, err);
    });
}

function handleSeriesProfile(userId, profileName) {
  var profileList = cache.get('seriesProfileList' + userId);
  if (profileList === undefined) {
    throw new Error('something went wrong, try searching again');
  }

  var profile = _.filter(profileList, function(item) {
    return item.label == profileName;
  })[0];

  if (profile === undefined) {
    throw new Error('could not find the profile ' + profileName);
  }

  // set series option to cache
  cache.set('seriesProfileId' + userId, profile.id);

  sonarr.get('rootfolder')
    .then(function(result) {
      if (!result.length) {
        throw new Error('could not get folders, try searching again');
      }

      if (cache.get('seriesList' + userId) === undefined) {
        throw new Error('could not get previous list, try searching again');
      }
      return result;
    })
    .then(function(folders) {
      logger.info('user: %s, message: requested to get folder list', userId);

      var folderList = [];
      var keyboardList = [];
      var response = ['*Found ' + folders.length + ' folders:*'];
      _.forEach(folders, function(n, key) {
        folderList.push({
          'id': key + 1,
          'path': n.path,
          'folderId': n.id
        });

        response.push('*' + (key + 1) + '*) ' + n.path);

        keyboardList.push([n.path]);
      });
      response.push(i18n.__('selectFromMenu'));

      logger.info('user: %s, message: found the following folders %s', userId, keyboardList.join(', '));

      // set cache
      cache.set('seriesFolderList' + userId, folderList);
      cache.set('state' + userId, state.sonarr.FOLDER);

      return new Response(response.join('\n'), keyboardList);
    })
    .then(function(response) {
      var keyboard = {
        keyboard: response.keyboard,
        one_time_keyboard: true
      };
      var opts = {
        'disable_web_page_preview': true,
        'parse_mode': 'Markdown',
        'selective': 2,
        'reply_markup': JSON.stringify(keyboard),
      };
      bot.sendMessage(userId, response.message, opts);
    })
    .catch(function(err) {
      replyWithError(userId, err);
    });
}

function handleSeriesFolder(userId, folderName) {
  var seriesId = cache.get('seriesId' + userId);
  var seriesList = cache.get('seriesList' + userId);
  var folderList = cache.get('seriesFolderList' + userId);

  if (seriesList === undefined || seriesId === undefined || folderList === undefined) {
    return replyWithError(userId, new Error('Something went wrong, try searching again'));
  }

  var folder = _.filter(folderList, function(item) {
    return item.path == folderName;
  })[0];

  // set movie option to cache
  cache.set('seriesFolderId' + userId, folder.folderId);

  logger.info('user: %s, message: requested to get monitor list', userId);

  var monitor = ['future', 'all', 'none', 'latest', 'first'];
  var monitorList = [];
  var keyboardList = [];
  var keyboardRow = [];
  var response = ['*Select which seasons to monitor:*'];
  _.forEach(monitor, function(n, key) {
    monitorList.push({
      'id': key + 1,
      'type': n
    });

    response.push('*' + (key + 1) + '*) ' + n);

    keyboardRow.push(n);
    if (keyboardRow.length == 2) {
      keyboardList.push(keyboardRow);
      keyboardRow = [];
    }
  });

  if (keyboardRow.length == 1) {
    keyboardList.push([keyboardRow[0]]);
  }

  response.push(i18n.__('selectFromMenu'));

  logger.info('user: %s, message: found the following monitor types %s', userId, keyboardList.join(', '));

  // set cache
  cache.set('seriesMonitorList' + userId, monitorList);
  cache.set('state' + userId, state.sonarr.MONITOR);

  var keyboard = {
    keyboard: keyboardList,
    one_time_keyboard: true
  };
  var opts = {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
    'reply_markup': JSON.stringify(keyboard),
  };
  bot.sendMessage(userId, response.join('\n'), opts);
}

function handleSeriesMonitor(userId, monitorType) {
  var seriesId = cache.get('seriesId' + userId);
  var seriesList = cache.get('seriesList' + userId);
  var profileId = cache.get('seriesProfileId' + userId);
  var profileList = cache.get('seriesProfileList' + userId);
  var folderId = cache.get('seriesFolderId' + userId);
  var folderList = cache.get('seriesFolderList' + userId);
  var monitorList = cache.get('seriesMonitorList' + userId);

  if (folderList === undefined || profileList === undefined || seriesList === undefined || monitorList === undefined) {
    throw new Error('something went wrong, try searching again');
  }

  var series = _.filter(seriesList, function(item) {
    return item.id == seriesId;
  })[0];

  var profile = _.filter(profileList, function(item) {
    return item.id == profileId;
  })[0];

  var folder = _.filter(folderList, function(item) {
    return item.folderId == folderId;
  })[0];

  var monitor = _.filter(monitorList, function(item) {
    return item.type == monitorType;
  })[0];

  var postOpts = {};
  postOpts.tvdbId = series.tvdbId;
  postOpts.title = series.title;
  postOpts.titleSlug = series.titleSlug;
  postOpts.rootFolderPath = folder.path;
  postOpts.seasonFolder = true;
  postOpts.monitored = true;
  postOpts.seriesType = 'standard';
  postOpts.qualityProfileId = profile.profileId;

  var lastSeason = _.max(series.seasons, 'seasonNumber');
  var firstSeason = _.min(_.reject(series.seasons, {
    seasonNumber: 0
  }), 'seasonNumber');

  if (monitor.type === 'future') {
    postOpts.addOptions = {};
    postOpts.addOptions.ignoreEpisodesWithFiles = true;
    postOpts.addOptions.ignoreEpisodesWithoutFiles = true;
  } else if (monitor.type === 'all') {
    postOpts.addOptions = {};
    postOpts.addOptions.ignoreEpisodesWithFiles = false;
    postOpts.addOptions.ignoreEpisodesWithoutFiles = false;
  } else if (monitor.type === 'none') {
    // mark all seasons (+1) not monitored
    _.each(series.seasons, function(season) {
      if (season.seasonNumber >= lastSeason.seasonNumber + 1) {
        season.monitored = true;
      } else {
        season.monitored = false;
      }
    });
  } else if (monitor.type === 'latest') {
    // update latest season to be monitored
    _.each(series.seasons, function(season) {
      if (season.seasonNumber >= lastSeason.seasonNumber) {
        season.monitored = true;
      } else {
        season.monitored = false;
      }
    });
  } else if (monitor.type === 'first') {
    // mark all as not monitored
    _.each(series.seasons, function(season) {
      if (season.seasonNumber >= lastSeason.seasonNumber + 1) {
        season.monitored = true;
      } else {
        season.monitored = false;
      }
    });

    // update first season
    _.each(series.seasons, function(season) {
      if (season.seasonNumber === firstSeason.seasonNumber) {
        season.monitored = !season.monitored;
      }
    });
  }

  // update seasons to be monitored
  postOpts.seasons = series.seasons;

  logger.info('user: %s, message: adding series "%s" with options %s', userId, series.title, JSON.stringify(postOpts));

  sonarr.post('series', postOpts)
    .then(function(result) {
      logger.info('user: %s, message: added series "%s"', userId, series.title);

      if (!result) {
        throw new Error('could not add series, try searching again.');
      }

      bot.sendMessage(userId, 'Series `' + series.title + '` added', {
        'selective': 2,
        'parse_mode': 'Markdown'
      });
    })
    .catch(function(err) {
      replyWithError(userId, err);
    })
    .finally(function() {
      clearCache(userId);
    });
}

function handleRevokeUser(userId, revokedUser) {

  var keyboardList = [];
  var response = ['Are you sure you want to revoke access to ' + revokedUser + '?'];
  keyboardList.push(['NO']);
  keyboardList.push(['yes']);

  // set cache
  cache.set('state' + userId, state.admin.REVOKE_CONFIRM);
  cache.set('revokedUserName' + userId, revokedUser);

  logger.info('user: %s, message: selected revoke user %s', userId, revokedUser);

  var keyboard = {
    keyboard: keyboardList,
    one_time_keyboard: true
  };
  var opts = {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
    'reply_markup': JSON.stringify(keyboard),
  };
  bot.sendMessage(userId, response.join('\n'), opts);
}

function handleRevokeUserConfirm(userId, revokedConfirm) {

  logger.info('user: %s, message: selected revoke confirmation %s', userId, revokedConfirm);

  var revokedUser = cache.get('revokedUserName' + userId);
  var opts = {};
  var message = '';
  if (revokedConfirm === 'NO' || revokedConfirm === 'no') {
      clearCache(userId);
      message = 'Access for ' + revokedUser + ' has *NOT* been revoked.';
      opts = {
        'disable_web_page_preview': true,
         'parse_mode': 'Markdown',
        'selective': 2,
      };
      return bot.sendMessage(userId, message, opts);
  }
  var revokedUserList = cache.get('revokeUserList' + userId);
  var i = revokedUserList.map(function(e) { return e.keyboardValue; }).indexOf(revokedUser);
  var revokedUserObj = revokedUserList[i];
  var j = acl.allowedUsers.map(function(e) { return e.id; }).indexOf(revokedUserObj.userId);

  acl.revokedUsers.push(acl.allowedUsers[j]);
  acl.allowedUsers.splice(j, 1);
  updateACL();

  message = 'Access for ' + revokedUser + ' has been revoked.';
  opts = {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
  };
  bot.sendMessage(userId, message, opts);
  clearCache(userId);
}

function handleUnRevokeUser(userId, revokedUser) {

  var keyboardList = [];
  var response = ['Are you sure you want to unrevoke access for ' + revokedUser + '?'];
  keyboardList.push(['NO']);
  keyboardList.push(['yes']);

  // set cache
  cache.set('state' + userId, state.admin.UNREVOKE_CONFIRM);
  cache.set('revokedUserName' + userId, revokedUser);

  logger.info('user: %s, message: selected unrevoke user %s', userId, revokedUser);

  var keyboard = {
    keyboard: keyboardList,
    one_time_keyboard: true
  };
  var opts = {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
    'reply_markup': JSON.stringify(keyboard),
  };
  bot.sendMessage(userId, response.join('\n'), opts);
}

function handleUnRevokeUserConfirm(userId, revokedConfirm) {

  logger.info('user: %s, message: selected unrevoke confirmation %s', userId, revokedConfirm);

  var revokedUser = cache.get('revokedUserName' + userId);
  var opts = {};
  var message = '';
  if (revokedConfirm === 'NO' || revokedConfirm === 'no') {
      clearCache(userId);
      message = 'Access for ' + revokedUser + ' has *NOT* been unrevoked.';
      opts = {
        'disable_web_page_preview': true,
         'parse_mode': 'Markdown',
        'selective': 2,
      };
      return bot.sendMessage(userId, message, opts);
  }

  var unrevokedUserList = cache.get('unrevokeUserList' + userId);
  var i = unrevokedUserList.map(function(e) { return e.keyboardValue; }).indexOf(revokedUser);
  var unrevokedUserObj = unrevokedUserList[i];
  var j = acl.revokedUsers.map(function(e) { return e.id; }).indexOf(unrevokedUserObj.userId);
  acl.revokedUsers.splice(j, 1);
  updateACL();

  message = 'Access for ' + revokedUser + ' has been unrevoked.';
  opts = {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
  };
  bot.sendMessage(userId, message, opts);
  clearCache(userId);
}

/*
 * save access control list
 */
function updateACL() {
  fs.writeFile(__dirname + '/acl.json', JSON.stringify(acl), function(err) {
    if (err) {
      throw new Error(err);
    }

    logger.info('the access control list was updated!');
  });
}

/*
 * verify user can use the bot
 */
function verifyUser(userId) {
  if (_.some(acl.allowedUsers, { 'id': userId }) !== true) {
    return replyWithError(userId, new Error(i18n.__('notAuthorized')));
  }
}

/*
 * verify admin of the bot
 */
function verifyAdmin(userId) {
  if (isAuthorized(userId)) {
    promptOwnerConfig(userId);
  }

  if (config.bot.owner !== userId) {
    return replyWithError(userId, new Error(i18n.__('adminOnly')));
  }
}

/*
 * check to see is user is authenticated
 * returns true/false
 */
function isAuthorized(userId) {
  return _.some(acl.allowedUsers, { 'id': userId });
}

/*
 * check to see is user is banned
 * returns true/false
 */
function isRevoked(userId) {
  return _.some(acl.revokedUsers, { 'id': userId });
}

function promptOwnerConfig(userId) {
  if (config.bot.owner === 0) {
    var message = ['Your User ID: ' + userId];
    message.push('Please add your User ID to the config file field labeled \'owner\'.');
    message.push('Please restart the bot once this has been updated.');
    bot.sendMessage(userId, message.join('\n'));
  }
}

/*
 * handle removing the custom keyboard
 */
function replyWithError(userId, err) {

  logger.warn('user: %s message: %s', userId, err.message);

  bot.sendMessage(userId, 'Oh no! ' + err, {
    'parse_mode': 'Markdown',
    'reply_markup': {
      'hide_keyboard': false
    }
  });
}

/*
 * clear caches
 */
function clearCache(userId) {
  var cacheItems = [
    'seriesId', 'seriesList', 'seriesProfileId',
    'seriesProfileList', 'seriesFolderId',
    'seriesFolderList', 'seriesMonitorList',
    'state', 'revokedUserName', 'revokeUserList'
  ];

  _(cacheItems).forEach(function(item) {
    cache.del(item + userId);
  });
}

/*
 * get telegram name
 */
function getTelegramName(user) {
   return user.username || (user.first_name + (' ' + user.last_name || ''));
}
