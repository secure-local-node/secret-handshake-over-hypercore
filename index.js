const { Connection } = require('./connection')
const { capability } = require('./capability')
const { keygen } = require('./keygen')

function connect(sharedKey, opts, cb) {
  const connection = new Connection(Object.assign({ sharedKey }, opts))
  connection.connect(cb)
  return connection
}


module.exports = {
  Connection,
  capability,
  connect,
  keygen,
}
