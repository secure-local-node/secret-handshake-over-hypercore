const { keyPair } = require('hypercore-crypto')

function keygen(seed) {
  return keyPair(seed)
}

module.exports = {
  keygen
}
