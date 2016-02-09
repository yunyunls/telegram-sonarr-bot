'use strict';
var fs = require("fs")
var logger = require(__dirname + '/lib/logger');
var config = require(__dirname + '/lib/config');
var TelegramBot = require('node-telegram-bot-api');

var bot = new TelegramBot(config.telegram.botToken, { polling: false });

var groupId = config.bot.notifyId;

var episode_path = process.env.sonarr_episodefile_relativepath || 'Unknown Episode';
var quality = process.env.sonarr_episodefile_quality || 'Unknown Quality';
var source  = process.env.sonarr_episodefile_scenename || 'Unknown Name';
var target  = process.env.sonarr_episodefile_path || 'Unknown path';
var title   = process.env.sonarr_series_title || 'Unknown Title';
var season  = process.env.sonarr_episodefile_seasonnumber || 'Unknown Season';
var episode = process.env.sonarr_episodefile_episodenumbers || 'Unknown Episode';

var fileSizeInMegaBytes = 0;

try {
  var stats = fs.statSync(target)
  fileSizeInMegaBytes = Math.round((stats['size'] / 1048576) * 10) / 10;
}
catch (e) {
  logger.error("err:" + e);
}

var message = [];
message.push('*Episode Imported*');
message.push(title + ' - ' + season + 'x' + episode);
//message.push('*Source:* ' + source);
message.push('*Size:* ' + fileSizeInMegaBytes + ' MB');
//message.push('*Destination:* ' + target);

bot.sendMessage(groupId, message.join('\n'), {
  'disable_web_page_preview': true,
  'parse_mode': 'Markdown',
  'selective': 2,
});
