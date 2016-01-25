'use strict';

var fs          = require('fs');                        // https://nodejs.org/api/fs.html
var _           = require('lodash');                    // https://www.npmjs.com/package/lodash
var NodeCache   = require('node-cache');                // https://www.npmjs.com/package/node-cache
var TelegramBot = require('node-telegram-bot-api');     // https://www.npmjs.com/package/node-telegram-bot-api

/*
 * libs
 */
var state  = require(__dirname + '/lib/state');         // handles command structure
var logger = require(__dirname + '/lib/logger');        // logs to file and console
var i18n   = require(__dirname + '/lib/lang');          // set up multilingual support
var config = require(__dirname + '/lib/config');        // the concised configuration
var acl    = require(__dirname + '/lib/acl');           // set up the acl file

/*
 * modules
 */
var SonarrMessage = require(__dirname + '/modules/SonarrMessage');

/*
 * set up the telegram bot
 */
var bot = new TelegramBot(config.telegram.botToken, { polling: true });

/*
 * set up a simple caching tool
 */
var cache = new NodeCache({ stdTTL: 120, checkperiod: 150 });

/*
 * get the bot name
 */
bot.getMe().then(function(msg) {
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

  verifyUser(fromId);

  logger.info('user: %s, message: sent \'/start\' command', fromId);

  var response = ['Hello ' + getTelegramName(msg.from) + '!'];
  response.push('Below is a list of commands you have access to');
  response.push('\n*General commands:*');
  response.push('/start to start this bot');
  response.push('`/query [series]` add new TV series');
  response.push('`/library [series]` search Sonarr library');
  response.push('/upcoming shows upcoming episodes');
  response.push('/clear clear all previous commands');

  if (isAdmin(fromId)) {
    response.push('\n*Admin commands:*');
    response.push('/wanted search all missing/wanted episodes');
    response.push('/rss perform an RSS Sync');
    response.push('/refresh refreshes all series');
    response.push('/users list users');
    response.push('/revoke revoke user from bot');
    response.push('/unrevoke un-revoke user from bot');
  }

  return bot.sendMessage(fromId, response.join('\n'), { 'parse_mode': 'Markdown', 'selective': 2 });
});

/*
 * handle sonarr commands
 */
bot.on('message', function(msg) {
  var user    = msg.from;
  var message = msg.text;

  var sonarr = new SonarrMessage(bot, user, cache);

  if (/^\/library\s?(.+)?$/g.test(message)) {
    var searchText = /^\/library\s?(.+)?/g.exec(message)[1] || null;
    return sonarr.performLibrarySearch(searchText);
  }

  if(/^\/rss$/g.test(message)) {
    verifyAdmin(user.id);
    return sonarr.performRssSync();
  }

  if(/^\/wanted$/g.test(message)) {
    verifyAdmin(user.id);
    return sonarr.performWantedSearch();
  }

  if(/^\/refresh$/g.test(message)) {
    verifyAdmin(user.id);
    return sonarr.performLibraryRefresh();
  }

  if (/^\/upcoming\s?(\d+)?$/g.test(message)) {
    verifyUser(user.id);
    var futureDays = /^\/upcoming\s?(\d+)?/g.exec(message)[1] || 3;
    return sonarr.performCalendarSearch(futureDays);
  }

  /*
   * /query command
   */
  if (/^\/[Qq](uery)? (.+)$/g.test(message)) {
    verifyUser(user.id);
    var seriesName = /^\/[Qq](uery)? (.+)/g.exec(message)[2] || null;
    return sonarr.sendSeriesList(seriesName);
  }

  // get the current cache state
  var currentState = cache.get('state' + user.id);

  if (currentState === state.sonarr.PROFILE) {
    verifyUser(user.id);
    logger.info('user: %s, message: choose the series %s', user.id, message);
    return sonarr.sendProfileList(message);
  }

  if (currentState === state.sonarr.MONITOR) {
    verifyUser(user.id);
    logger.info('user: %s, message: choose the profile "%s"', user.id, message);
    return sonarr.sendMonitorList(message);
  }

  if (currentState === state.sonarr.TYPE) {
    verifyUser(user.id);
    logger.info('user: %s, message: choose the type "%s"', user.id, message);
    return sonarr.sendTypeList(message);
  }

  if (currentState === state.sonarr.FOLDER) {
    verifyUser(user.id);
    logger.info('user: %s, message: choose the folder "%s"', user.id, message);
    return sonarr.sendFolderList(message);
  }

  if (currentState === state.sonarr.SEASON_FOLDER) {
    verifyUser(user.id);
    logger.info('user: %s, message: choose the season folder "%s"', user.id, message);
    return sonarr.sendSeasonFolderList(message);
  }

  if (currentState === state.sonarr.ADD_SERIES) {
    verifyUser(user.id);
    return sonarr.sendAddSeries(message);
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

  if (password !== config.bot.password) {
    return replyWithError(fromId, new Error('Invalid password.'));
  }

  acl.allowedUsers.push(msg.from);
  updateACL();

  if (acl.allowedUsers.length === 1) {
    promptOwnerConfig(fromId);
  }

  if (config.bot.owner) {
    bot.sendMessage(config.bot.owner, getTelegramName(msg.from) + ' has been granted access.');
  }

  message.push('You have been authorized.');
  message.push('Type /start to begin.');

  return bot.sendMessage(fromId, message.join('\n'));
});

/*
 * handle users
 */
bot.onText(/\/users/, function(msg) {
  var fromId = msg.from.id;

  verifyAdmin(fromId);

  var response = ['*Allowed Users:*'];
  _.forEach(acl.allowedUsers, function(n, key) {
    response.push('➸ ' + getTelegramName(n));
  });

  return bot.sendMessage(fromId, response.join('\n'), {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
  });
});

/*
 * handle user access revocation
 */
bot.onText(/\/revoke/, function(msg) {
  var fromId = msg.from.id;

  verifyAdmin(fromId);

  var opts = {};

  if (!acl.allowedUsers.length) {
    var message = 'There aren\'t any allowed users.';

    opts = {
      'disable_web_page_preview': true,
      'parse_mode': 'Markdown',
      'selective': 2,
    };

    return bot.sendMessage(fromId, message, opts);
  }

  var keyboardList = [], keyboardRow = [], revokeList = [];
  var response = ['*Allowed Users:*'];
  _.forEach(acl.allowedUsers, function(n, key) {
    revokeList.push({
      'id': key + 1,
      'userId': n.id,
      'keyboardValue': getTelegramName(n)
    });
    response.push('➸ ' + getTelegramName(n));

    keyboardRow.push(getTelegramName(n));
    if (keyboardRow.length === 2) {
      keyboardList.push(keyboardRow);
      keyboardRow = [];
    }
  });

  response.push(i18n.__('selectFromMenu'));


  if (keyboardRow.length === 1) {
    keyboardList.push([keyboardRow[0]]);
  }

  // set cache
  cache.set('state' + fromId, state.admin.REVOKE);
  cache.set('revokeUserList' + fromId, revokeList);

  return bot.sendMessage(fromId, response.join('\n'), {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
    'reply_markup': JSON.stringify({ keyboard: keyboardList, one_time_keyboard: true }),
  });
});

/*
 * handle user access unrevocation
 */
bot.onText(/\/unrevoke/, function(msg) {
  var fromId = msg.from.id;

  verifyAdmin(fromId);

  var opts = {};

  if (!acl.revokedUsers.length) {
    var message = 'There aren\'t any revoked users.';

    return bot.sendMessage(fromId, message, {
      'disable_web_page_preview': true,
      'parse_mode': 'Markdown',
      'selective': 2,
    });
  }

  var keyboardList = [], keyboardRow = [], revokeList = [];
  var response = ['*Revoked Users:*'];
  _.forEach(acl.revokedUsers, function(n, key) {
    revokeList.push({
      'id': key + 1,
      'userId': n.id,
      'keyboardValue': getTelegramName(n)
    });

    response.push('➸ ' + getTelegramName(n));

    keyboardRow.push(getTelegramName(n));
    if (keyboardRow.length == 2) {
      keyboardList.push(keyboardRow);
      keyboardRow = [];
    }
  });

  response.push(i18n.__('selectFromMenu'));

  if (keyboardRow.length === 1) {
    keyboardList.push([keyboardRow[0]]);
  }

  // set cache
  cache.set('state' + fromId, state.admin.UNREVOKE);
  cache.set('unrevokeUserList' + fromId, revokeList);

  return bot.sendMessage(fromId, response.join('\n'), {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
    'reply_markup': JSON.stringify({ keyboard: keyboardList, one_time_keyboard: true })
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

  return bot.sendMessage(fromId, 'All previously sent commands have been cleared, yey!', {
    'reply_markup': {
      'hide_keyboard': true
    }
  });
});

/*
 * @TODO  AdminMessage module ?
 * revoke user
 */
function handleRevokeUser(userId, revokedUser) {

  logger.info('user: %s, message: selected revoke user %s', userId, revokedUser);

  var keyboardList = [];
  var response = ['Are you sure you want to revoke access to ' + revokedUser + '?'];
  keyboardList.push(['NO']);
  keyboardList.push(['yes']);

  // set cache
  cache.set('state' + userId, state.admin.REVOKE_CONFIRM);
  cache.set('revokedUserName' + userId, revokedUser);

  return bot.sendMessage(userId, response.join('\n'), {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
    'reply_markup': JSON.stringify({ keyboard: keyboardList, one_time_keyboard: true }),
  });
}

/*
 * confirm revoked user
 */
function handleRevokeUserConfirm(userId, revokedConfirm) {

  logger.info('user: %s, message: selected revoke confirmation %s', userId, revokedConfirm);

  var revokedUser = cache.get('revokedUserName' + userId);
  var opts = {};
  var message = '';

  if (revokedConfirm === 'NO' || revokedConfirm === 'no') {
      clearCache(userId);
      message = 'Access for ' + revokedUser + ' has *NOT* been revoked.';
      return bot.sendMessage(userId, message, {
        'disable_web_page_preview': true,
         'parse_mode': 'Markdown',
        'selective': 2,
      });
  }

  var revokedUserList = cache.get('revokeUserList' + userId);
  var i = revokedUserList.map(function(e) { return e.keyboardValue; }).indexOf(revokedUser);
  var revokedUserObj = revokedUserList[i];
  var j = acl.allowedUsers.map(function(e) { return e.id; }).indexOf(revokedUserObj.userId);

  acl.revokedUsers.push(acl.allowedUsers[j]);
  acl.allowedUsers.splice(j, 1);
  updateACL();

  message = 'Access for ' + revokedUser + ' has been revoked.';

  return bot.sendMessage(userId, message, {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2
  });
}

/*
 * unrevoke user
 */
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

  return bot.sendMessage(userId, response.join('\n'), {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
    'reply_markup': JSON.stringify({keyboard: keyboardList, one_time_keyboard: true })
  });
}

/*
 * confirm unrevoked user
 */
function handleUnRevokeUserConfirm(userId, revokedConfirm) {

  logger.info('user: %s, message: selected unrevoke confirmation %s', userId, revokedConfirm);

  var revokedUser = cache.get('revokedUserName' + userId);
  var opts = {};
  var message = '';
  if (revokedConfirm === 'NO' || revokedConfirm === 'no') {
      clearCache(userId);
      message = 'Access for ' + revokedUser + ' has *NOT* been unrevoked.';
      return bot.sendMessage(userId, message, {
        'disable_web_page_preview': true,
        'parse_mode': 'Markdown',
        'selective': 2,
      });
  }

  var unrevokedUserList = cache.get('unrevokeUserList' + userId);
  var i = unrevokedUserList.map(function(e) { return e.keyboardValue; }).indexOf(revokedUser);
  var unrevokedUserObj = unrevokedUserList[i];
  var j = acl.revokedUsers.map(function(e) { return e.id; }).indexOf(unrevokedUserObj.userId);
  acl.revokedUsers.splice(j, 1);
  updateACL();

  message = 'Access for ' + revokedUser + ' has been unrevoked.';

  return bot.sendMessage(userId, message, {
    'disable_web_page_preview': true,
    'parse_mode': 'Markdown',
    'selective': 2,
  });
}

/*
 * save access control list
 */
function updateACL() {
  fs.writeFile(__dirname + '/acl.json', JSON.stringify(acl), function(err) {
    if (err) {
      throw new Error(err);
    }

    logger.info('the access control list was updated');
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
 * is this userId a admin?
 */
function isAdmin(userId) {
  if (config.bot.owner === userId) {
    return true;
  }
  return false;
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

/*
 * prompt for admin message
 */
function promptOwnerConfig(userId) {
  if (!config.bot.owner) {
    var message = ['Your User ID: ' + userId];
    message.push('Please add your User ID to the config file field labeled \'owner\'.');
    message.push('Please restart the bot once this has been updated.');
    return bot.sendMessage(userId, message.join('\n'));
  }
}

/*
 * handle removing the custom keyboard
 */
function replyWithError(userId, err) {
  logger.warn('user: %s message: %s', userId, err.message);
  return bot.sendMessage(userId, '*Oh no!* ' + err, {
    'parse_mode': 'Markdown',
    'reply_markup': {
      'hide_keyboard': true
    }
  });
}

/*
 * clear caches
 */
function clearCache(userId) {
  var cacheItems = [
    'seriesId', 'seriesList', 'seriesProfileId',
    'seriesProfileList', 'seriesFolderId', 'seriesFolderList',
    'seriesMonitorId', 'seriesMonitorList', 'seriesFolderId',
    'seriesFolderList', 'seriesTypeId', 'seriesTypeList',
    'seriesSeasonFolderList',
    'revokedUserName', 'revokeUserList',
    'state'
  ];

  _(cacheItems).forEach(function(item) {
    cache.del(item + userId);
  });
}

/*
 * get telegram name
 */
function getTelegramName(user) {
  if (typeof user === 'object') {
    return user.username || (user.first_name + (' ' + user.last_name || ''));
  }
  if (typeof user === 'number') {
    var aclUser = _.filter(acl.allowedUsers, function(item) { return item.id === user; })[0];
    return aclUser.username || (aclUser.first_name + (' ' + aclUser.last_name || ''));
  }
  return 'unknown user';
}
