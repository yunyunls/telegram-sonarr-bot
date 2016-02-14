'use strict';
var fs = require("fs")
var logger = require(__dirname + '/lib/logger');
var config = require(__dirname + '/lib/config');
var TelegramBot = require('node-telegram-bot-api');

var bot = new TelegramBot(config.telegram.botToken, { polling: false });

var groupId = config.bot.notifyId;

var series_id = process.env.sonarr_series_id || 'Unknown ID';
var series_title   = process.env.sonarr_series_title || 'Unknown Title';
var series_path = process.env.sonarr_series_path || 'Unknown Path';
var series_tvdbid = process.env.sonarr_series_tvdbid || 'Unknown TVDB ID';
var episodefile_id = process.env.sonarr_episodefile_id || 'Unknown File ID';
var episodefile_relativepath = process.env.sonarr_episodefile_relativepath || 'Unknown Relative Path';
var target  = process.env.sonarr_episodefile_path || 'Unknown Path';
var season  = process.env.sonarr_episodefile_seasonnumber || 'Unknown Season';
var episode = process.env.sonarr_episodefile_episodenumbers || 'Unknown Episode';
var airdate = process.env.sonarr_episodefile_episodeairdates || 'Unknown Air Dates';
var airdateutc = process.env.sonarr_episodefile_episodeairdatesutc || 'Unknown UTC Air Dates';
var quality = process.env.sonarr_episodefile_quality || 'Unknown Quality';
var qualtiyversion = process.env.sonarr_episodefile_quality_version || 'Unknown Quality Version';
var releasegroup = process.env.sonarr_episodefile_releasegroup || 'Unknown Release Group';
var source  = process.env.sonarr_episodefile_scenename || 'Unknown Name';
var sourcepath = process.env.sonarr_episodefile_sourcepath || 'Unknown Source Path';
var sourcefolder = process.env.sonarr_episodefile_sourcefolder || 'Unknown Source Folder';

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
message.push(series_title + ' - ' + season + 'x' + episode);
message.push('*Air Date:* ' + airdate);
message.push('*Quality:* ' + quality);
message.push('*Size:* ' + fileSizeInMegaBytes + ' MB');

//message.push('*Series ID:* ' + series_id);
//message.push('*Path:* ' + series_path);
//message.push('*TVDB ID:* ' + series_tvdbid);
//message.push('*Episode ID:* ' + episodefile_id);
//message.push('*Rel Path:* ' + episodefile_relativepath);
//message.push('*Air Date UTC:* ' + airdateutc);
//message.push('*Quality Version:* ' + qualtiyversion);
//message.push('*Release Group:* ' + releasegroup);
//message.push('*Source:* ' + source);
//message.push('*Source Path:* ' + sourcepath);
//message.push('*Source Folder:* ' + sourcefolder);
//message.push('*Destination:* ' + target);

bot.sendMessage(groupId, message.join('\n'), {
  'disable_web_page_preview': true,
  'parse_mode': 'Markdown',
  'selective': 2,
});
