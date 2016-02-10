var request = require('request')
var gitterClient = require('./gitter.js')

module.exports = function (opts, onGitterMessage) {
  var gitter = gitterClient(opts.gitterApiKey)
  var headers = {
    'Accept': 'application/json',
    'Authorization': 'Bearer ' + opts.gitterApiKey
  }

  function log (message) {
    console.error(message)
  }

  request.post({ url: 'https://api.gitter.im/v1/rooms', headers: headers, json: {uri: opts.gitterRoom} }, function (err, req, json) {
    if (err) return log(err)
    var gitterRoomId = json.id
    var postGitterMessageUrl = 'https://api.gitter.im/v1/rooms/' + gitterRoomId + '/chatMessages'

    request({url: 'https://api.gitter.im/v1/user', headers: headers, json: true}, function (err, res, json) {
      if (err) return log(err)
      var gitterName = json[0].username
      var gitterUserId = json[0].id
      log('Gitterbot ' + gitterName + ' on channel ' + opts.gitterRoom + '(' + gitterRoomId + ')')

      gitter.subscribe('/api/v1/rooms/' + gitterRoomId + '/chatMessages', gitterMessage, {})

      function gitterMessage (data) {
        if (data.operation !== 'create') return
        var message = data.model
        if (!message.fromUser) return
        var userName = message.fromUser.username
        if (userName === gitterName) return

        // mark message as read by bot
        request.post({
          url: 'https://api.gitter.im/v1/user/' + gitterUserId + '/rooms/' + gitterRoomId + '/unreadItems',
          headers: headers,
          json: {chat: [ message.id ]}
        })

        onGitterMessage(gitterRoomId, userName, message.text)
      }

      /*
       * TODO: relay messages from Matrix using something like:
         request.post({url: postGitterMessageUrl, headers: headers, json: {text: text}})
      */
    })
  })
}
