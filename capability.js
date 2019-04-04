const crypto = require('ara-crypto')

function capability(name, shouldNormalize = true) {
  return crypto.blake2b(Buffer.from(
    shouldNormalize
    ? normalize(name)
    : name
  ))
}

function normalize(name) {
  if ('string' === typeof name) {
    return name.trim().replace(/[\s|\n|\t|\r]+/g, '')
  }
}

module.exports = {
  capability,
  normalize,
}
