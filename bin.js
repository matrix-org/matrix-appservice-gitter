#!/usr/bin/env node
var gitterBot = require('./')

var opts = {
  gitterApiKey: process.env['GITTERBOT_APIKEY'],
  gitterRoom: process.env['GITTERBOT_GITTER_ROOM']
}

if (!(opts.gitterApiKey && opts.gitterRoom)) {
  console.error('You need to set the config env variables (see readme.md)')
  process.exit(1)
}

function onGitterMessage(roomId, fromUser, text) {
  console.log('gitter->' + roomId + ' from ' + fromUser + ':', text)
}

gitterBot(opts, onGitterMessage)
